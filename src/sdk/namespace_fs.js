/* Copyright (C) 2020 NooBaa */
/*eslint max-lines: ["error", 3000]*/
/*eslint max-statements: ["error", 80, { "ignoreTopLevelFunctions": true }]*/
'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const util = require('util');
const mime = require('mime');
const { v4: uuidv4 } = require('uuid');
const P = require('../util/promise');
const dbg = require('../util/debug_module')(__filename);
const config = require('../../config');
const s3_utils = require('../endpoint/s3/s3_utils');
const error_utils = require('../util/error_utils');
const stream_utils = require('../util/stream_utils');
const buffer_utils = require('../util/buffer_utils');
const size_utils = require('../util/size_utils');
const ChunkFS = require('../util/chunk_fs');
const LRUCache = require('../util/lru_cache');
const Semaphore = require('../util/semaphore');
const nb_native = require('../util/nb_native');
const RpcError = require('../rpc/rpc_error');

const buffers_pool_sem = new Semaphore(config.NSFS_BUF_POOL_MEM_LIMIT, {
    timeout: config.IO_STREAM_SEMAPHORE_TIMEOUT,
    timeout_error_code: 'IO_STREAM_ITEM_TIMEOUT',
    warning_timeout: config.NSFS_SEM_WARNING_TIMEOUT,
});
const buffers_pool = new buffer_utils.BuffersPool({
    buf_size: config.NSFS_BUF_SIZE,
    sem: buffers_pool_sem,
    warning_timeout: config.NSFS_BUF_POOL_WARNING_TIMEOUT,
    buffer_alloc: size => nb_native().fs.dio_buffer_alloc(size),
});

const XATTR_USER_PREFIX = 'user.';
// TODO: In order to verify validity add content_md5_mtime as well
const XATTR_CONTENT_TYPE = XATTR_USER_PREFIX + 'content_type';
const XATTR_MD5_KEY = XATTR_USER_PREFIX + 'content_md5';
const XATTR_VERSION_ID = XATTR_USER_PREFIX + 'version_id';
const XATTR_PREV_VERSION_ID = XATTR_USER_PREFIX + 'prev_version_id';
const XATTR_DELETE_MARKER = XATTR_USER_PREFIX + 'delete_marker';
const XATTR_DIR_CONTENT = XATTR_USER_PREFIX + 'dir_content';
const HIDDEN_VERSIONS_PATH = '.versions';
const NULL_VERSION_ID = 'null';

const INTERNAL_XATTR = [
    XATTR_CONTENT_TYPE,
    XATTR_DIR_CONTENT,
    XATTR_PREV_VERSION_ID,
    XATTR_DELETE_MARKER,
];

const versioning_status_enum = {
    VER_ENABLED: 'ENABLED',
    VER_SUSPENDED: 'SUSPENDED',
    VER_DISABLED: 'DISABLED'
};
const version_format = /^[a-z0-9]+$/;

const posix_link_retry_err = 'FS::SafeLink ERROR link target doesn\'t match expected inode and mtime';
const posix_unlink_retry_err = 'FS::SafeUnlink ERROR unlink target doesn\'t match expected inode and mtime';
const gpfs_link_unlink_retry_err = 'EEXIST';
const gpfs_unlink_retry_catch = 'GPFS_UNLINK_RETRY';

// describes the status of the copy that was done, default is fallback
// LINKED = the file was linked on the server side
// IS_SAME_INODE = source and target are the same inode, nothing to copy
// FALLBACK = will be reported when link on server side copy failed
// or on non server side copy
const copy_status_enum = {
    LINKED: 'LINKED',
    SAME_INODE: 'SAME_INODE',
    FALLBACK: 'FALLBACK'
};


/**
 * @param {fs.Dirent} a
 * @param {fs.Dirent} b
 * @returns {1|-1|0}
 */
function sort_entries_by_name(a, b) {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
}

function _is_version_object(filename) {
    const mtime_substr_index = filename.indexOf('_mtime-');
    if (mtime_substr_index < 0) return false;
    const ino_substr_index = filename.indexOf('-ino-');
    return ino_substr_index > mtime_substr_index;
}

function _get_mtime_from_filename(filename) {
    if (!_is_version_object(filename)) {
        // Latest file wont have time suffix which will push the latest
        // object last in the list. So to keep the order maintained,
        // returning the latest time. Multiplying with 1e6 to provide
        // nano second precision
        return BigInt(Date.now() * 1e6);
    }
    const file_parts = filename.split('-');
    return size_utils.string_to_bigint(file_parts[file_parts.length - 3], 36);
}

function _get_filename(file_name) {
    if (_is_version_object(file_name)) {
        return file_name.substring(0, file_name.indexOf('_mtime-'));
    }
    return file_name;
}
/**
 * @param {fs.Dirent} first_entry
 * @param {fs.Dirent} second_entry
 * @returns {Number}
 */
function sort_entries_by_name_and_time(first_entry, second_entry) {
    const first_entry_name = _get_filename(first_entry.name);
    const second_entry_name = _get_filename(second_entry.name);
    if (first_entry_name === second_entry_name) {
        const first_entry_mtime = _get_mtime_from_filename(first_entry.name);
        const second_entry_mtime = _get_mtime_from_filename(second_entry.name);
        // To sort the versions in the latest first order,
        // below logic is followed
        if (second_entry_mtime < first_entry_mtime) return -1;
        if (second_entry_mtime > first_entry_mtime) return 1;
        return 0;
    } else {
        if (first_entry_name < second_entry_name) return -1;
        if (first_entry_name > second_entry_name) return 1;
        return 0;
    }
}

function isDirectory(ent) {
    if (!ent) throw new Error('isDirectory: ent is empty');
    if (ent.mode) {
        // eslint-disable-next-line no-bitwise
        return (((ent.mode) & nb_native().fs.S_IFMT) === nb_native().fs.S_IFDIR);
    } else if (ent.type) {
        return ent.type === nb_native().fs.DT_DIR;
    } else {
        throw new Error(`isDirectory: ent ${ent} is not supported`);
    }
}

/**
 *
 * @param {*} stat - entity stat yo check
 * @param {*} fs_context - account config using to check symbolic links
 * @param {*} entry_path - path of symbolic link
 * @returns
 */
async function is_directory_or_symlink_to_directory(stat, fs_context, entry_path) {
    try {
        let r = isDirectory(stat);
        if (!r && is_symbolic_link(stat)) {
            const targetStat = await nb_native().fs.stat(fs_context, entry_path);
            if (!targetStat) throw new Error('is_directory_or_symlink_to_directory: targetStat is empty');
            r = isDirectory(targetStat);
        }
        return r;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }
}

function is_symbolic_link(stat) {
    if (!stat) throw new Error('isSymbolicLink: stat is empty');
    if (stat.mode) {
        // eslint-disable-next-line no-bitwise
        return (((stat.mode) & nb_native().fs.S_IFMT) === nb_native().fs.S_IFLNK);
    } else if (stat.type) {
        return stat.type === nb_native().fs.DT_LNK;
    } else {
        throw new Error(`isSymbolicLink: stat ${stat} is not supported`);
    }
}

/**
 * NOTICE that even files that were written sequentially, can still be identified as sparse:
 * 1. After writing, but before all the data is synced, the size is higher than blocks size.
 * 2. For files that were moved to an archive tier.
 * 3. For files that fetch and cache data from remote storage, which are still not in the cache.
 * It's not good enough for avoiding recall storms as needed by _fail_if_archived_or_sparse_file.
 * However, using this check is useful for guessing that a reads is going to take more time
 * and avoid holding off large buffers from the buffers_pool.
 * @param {nb.NativeFSStats} stat
 * @returns {boolean}
 */
function is_sparse_file(stat) {
    return (stat.blocks * 512 < stat.size);
}

function get_umasked_mode(mode) {
    // eslint-disable-next-line no-bitwise
    return mode & ~config.NSFS_UMASK;
}
/**
 * @param {fs.Dirent} e
 * @returns {string}
 */
function get_entry_name(e) {
    return e.name;
}

/**
 * @param {string} name
 * @returns {fs.Dirent}
 */
function make_named_dirent(name) {
    const entry = new fs.Dirent();
    entry.name = name;
    return entry;
}

function to_xattr(fs_xattr) {
    const xattr = _.mapKeys(fs_xattr, (val, key) =>
        (key.startsWith(XATTR_USER_PREFIX) && !INTERNAL_XATTR.includes(key) ? key.slice(XATTR_USER_PREFIX.length) : '')
    );
    // keys which do not start with prefix will all map to the empty string key, so we remove it once
    delete xattr[''];
    // @ts-ignore
    xattr[s3_utils.XATTR_SORT_SYMBOL] = true;
    return xattr;
}

function to_fs_xattr(xattr) {
    if (_.isEmpty(xattr)) return undefined;
    return _.mapKeys(xattr, (val, key) => XATTR_USER_PREFIX + key);
}


/**
 * @typedef {{
 *  time: number,
 *  stat: nb.NativeFSStats,
 *  usage: number,
 *  sorted_entries?: fs.Dirent[],
 * }} ReaddirCacheItem
 * @type {LRUCache<object, string, ReaddirCacheItem>}
 */
const dir_cache = new LRUCache({
    name: 'nsfs-dir-cache',
    make_key: ({ dir_path }) => dir_path,
    load: async ({ dir_path, fs_context }) => {
        const time = Date.now();
        const stat = await nb_native().fs.stat(fs_context, dir_path);
        let sorted_entries;
        let usage = config.NSFS_DIR_CACHE_MIN_DIR_SIZE;
        if (stat.size <= config.NSFS_DIR_CACHE_MAX_DIR_SIZE) {
            sorted_entries = await nb_native().fs.readdir(fs_context, dir_path);
            sorted_entries.sort(sort_entries_by_name);
            for (const ent of sorted_entries) {
                usage += ent.name.length + 4;
            }
        }
        return { time, stat, sorted_entries, usage };
    },
    validate: async ({ stat }, { dir_path, fs_context }) => {
        const new_stat = await nb_native().fs.stat(fs_context, dir_path);
        return (new_stat.ino === stat.ino && new_stat.mtimeNsBigint === stat.mtimeNsBigint);
    },
    item_usage: ({ usage }, dir_path) => usage,
    max_usage: config.NSFS_DIR_CACHE_MAX_TOTAL_SIZE,
});

/**
 * @typedef {{
 *  time: number,
 *  stat: nb.NativeFSStats,
 *  ver_dir_stat: nb.NativeFSStats,
 *  usage: number,
 *  sorted_entries?: fs.Dirent[],
 * }} ReaddirVersionsCacheItem
 * @type {LRUCache<object, string, ReaddirVersionsCacheItem>}
 */
const versions_dir_cache = new LRUCache({
    name: 'nsfs-versions-dir-cache',
    make_key: ({ dir_path }) => dir_path,
    load: async ({ dir_path, fs_context }) => {
        const time = Date.now();
        const stat = await nb_native().fs.stat(fs_context, dir_path);
        const version_path = dir_path + "/" + HIDDEN_VERSIONS_PATH;
        let ver_dir_stat_size;
        let is_version_path_exists = false;
        let ver_dir_stat;
        try {
            ver_dir_stat = await nb_native().fs.stat(fs_context, version_path);
            ver_dir_stat_size = ver_dir_stat.size;
            is_version_path_exists = true;
        } catch (err) {
            if (err.code === 'ENOENT') {
                dbg.log0('NamespaceFS: Version dir not found, ', version_path);
            } else {
                throw err;
            }
            ver_dir_stat = null;
            ver_dir_stat_size = 0;
        }
        let sorted_entries;
        let usage = config.NSFS_DIR_CACHE_MIN_DIR_SIZE;
        if (stat.size + ver_dir_stat_size <= config.NSFS_DIR_CACHE_MAX_DIR_SIZE) {
            const latest_versions = await nb_native().fs.readdir(fs_context, dir_path);
            if (is_version_path_exists) {
                const old_versions = await nb_native().fs.readdir(fs_context, version_path);
                const entries = latest_versions.concat(old_versions);
                sorted_entries = entries.sort(sort_entries_by_name_and_time);
            } else {
                sorted_entries = latest_versions.sort(sort_entries_by_name);
            }
            /*eslint no-unused-expressions: ["error", { "allowTernary": true }]*/
            for (const ent of sorted_entries) {
                usage += ent.name.length + 4;
            }
        }
        return { time, stat, ver_dir_stat, sorted_entries, usage };
    },
    validate: async ({ stat, ver_dir_stat }, { dir_path, fs_context }) => {
        const new_stat = await nb_native().fs.stat(fs_context, dir_path);
        if (ver_dir_stat) {
            const versions_dir_path = path.normalize(path.join(dir_path, '/', HIDDEN_VERSIONS_PATH));
            const new_versions_stat = await nb_native().fs.stat(fs_context, versions_dir_path);
            return (new_stat.ino === stat.ino &&
                    new_stat.mtimeNsBigint === stat.mtimeNsBigint &&
                    new_versions_stat.ino === ver_dir_stat.ino &&
                    new_versions_stat.mtimeNsBigint === ver_dir_stat.mtimeNsBigint);
        } else {
            return (new_stat.ino === stat.ino &&
            new_stat.mtimeNsBigint === stat.mtimeNsBigint);
        }
    },
    item_usage: ({ usage }, dir_path) => usage,
    max_usage: config.NSFS_DIR_CACHE_MAX_TOTAL_SIZE,
});

/**
 * NamespaceFS map objets to files in a filesystem.
 * @implements {nb.Namespace}
 */
class NamespaceFS {

    /**
     * @param {{
     *  bucket_path: string;
     *  fs_backend?: string;
     *  bucket_id: string;
     *  namespace_resource_id?: string;
     *  access_mode: string;
     *  versioning: 'DISABLED' | 'SUSPENDED' | 'ENABLED';
     *  stats: import('./endpoint_stats_collector').EndpointStatsCollector;
     *  force_md5_etag: boolean;
     * }} params
     */
    constructor({
        bucket_path,
        fs_backend,
        bucket_id,
        namespace_resource_id,
        access_mode,
        versioning,
        stats,
        force_md5_etag,
    }) {
        dbg.log1('NamespaceFS: buffers_pool length',
            buffers_pool.buffers.length, buffers_pool.sem);
        this.bucket_path = path.resolve(bucket_path);
        this.fs_backend = fs_backend;
        this.bucket_id = bucket_id;
        this.namespace_resource_id = namespace_resource_id;
        this.access_mode = access_mode;
        this.versioning = (config.NSFS_VERSIONING_ENABLED && versioning) || versioning_status_enum.VER_DISABLED;
        this.stats = stats;
        this.force_md5_etag = force_md5_etag;
        this.warmup_buffer = nb_native().fs.dio_buffer_alloc(4096);
    }

    /**
     * @param {nb.ObjectSDK} object_sdk 
     * @returns {nb.NativeFSContext}
     */
    prepare_fs_context(object_sdk) {
        const fs_context = object_sdk?.requesting_account?.nsfs_account_config;
        if (!fs_context) throw new RpcError('UNAUTHORIZED', 'nsfs_account_config is missing');
        fs_context.backend = this.fs_backend || '';
        fs_context.warn_threshold_ms = config.NSFS_WARN_THRESHOLD_MS;
        if (this.stats) fs_context.report_fs_stats = this.stats.update_fs_stats;
        return fs_context;
    }

    get_bucket_tmpdir() {
        return config.NSFS_TEMP_DIR_NAME + '_' + this.bucket_id;
    }

    get_write_resource() {
        return this;
    }

    get_bucket(bucket) {
        return bucket;
    }

    is_server_side_copy(other, params) {
        const is_server_side_copy = other instanceof NamespaceFS &&
            other.bucket_path === this.bucket_path &&
            other.fs_backend === this.fs_backend && //Check that the same backend type
            params.xattr_copy; // TODO, DO we need to hard link at MetadataDirective 'REPLACE'?
        dbg.log2('NamespaceFS: is_server_side_copy:', is_server_side_copy);
        dbg.log2('NamespaceFS: other instanceof NamespaceFS:', other instanceof NamespaceFS,
            'other.bucket_path:', other.bucket_path, 'this.bucket_path:', this.bucket_path,
            'other.fs_backend', other.fs_backend, 'this.fs_backend', this.fs_backend,
            'params.xattr_copy', params.xattr_copy);
        return is_server_side_copy;
    }

    run_update_issues_report(object_sdk, err) {
        if (!config.NSFS_UPDATE_ISSUES_REPORT_ENABLED) {
            dbg.log0('update_issues_report disabled:', this.namespace_resource_id, err);
            return;
        }
        //We want to avoid the report when we have no error code.
        if (!err.code) return;
        //In standalone, we want to avoid the report.
        if (!this.namespace_resource_id) return;
        try {
            object_sdk.rpc_client.pool.update_issues_report({
                namespace_resource_id: this.namespace_resource_id,
                error_code: err.code,
                time: Date.now(),
            });
        } catch (e) {
            console.log('update_issues_report on error:', e, 'ignoring.');
        }
    }

    is_readonly_namespace() {
        return this.access_mode === 'READ_ONLY';
    }

    /////////////////
    // OBJECT LIST //
    /////////////////

    /**
     * @typedef {{
     *  bucket: string,
     *  prefix?: string,
     *  delimiter?: string,
     *  key_marker?: string,
     *  limit?: number,
     * }} ListParams
     */

    /**
     * @param {ListParams} params
     */
    async list_objects(params, object_sdk) {
        return this._list_objects(params, object_sdk, false);
    }

    /**
     * @typedef {{
     *  bucket: string,
     *  prefix?: string,
     *  delimiter?: string,
     *  key_marker?: string,
     *  version_id_marker?: string,
     *  limit?: number,
     * }} ListVersionsParams
     */
    /**
     * @param {ListVersionsParams} params
     */
    async list_object_versions(params, object_sdk) {
        return this._list_objects(params, object_sdk, true);
    }

    async _list_objects(params, object_sdk, list_versions) {
        try {
            const fs_context = this.prepare_fs_context(object_sdk);
            await this._load_bucket(params, fs_context);

            const {
                bucket,
                delimiter = '',
                prefix = '',
                version_id_marker = '',
                key_marker = '',
            } = params;

            if (delimiter && delimiter !== '/') {
                throw new Error('NamespaceFS: Invalid delimiter ' + delimiter);
            }
            const limit = Math.min(1000, _.isUndefined(params.limit) ? 1000 : params.limit);
            if (limit < 0) throw new Error('Limit must be a positive Integer');
            // In case that we've received max-keys 0, we should return an empty reply without is_truncated
            // This is used in order to follow aws spec and behaviour
            if (!limit) return { is_truncated: false, objects: [], common_prefixes: [] };

            let is_truncated = false;

            /**
             * @typedef {{
             *  key: string,
             *  common_prefix: boolean,
             *  stat?: nb.NativeFSStats,
             * }} Result
             */

            /** @type {Result[]} */
            const results = [];

            /**
             * @param {string} dir_key
             * @returns {Promise<void>}
             */
            const process_dir = async dir_key => {
                if (this._is_hidden_version_path(dir_key)) {
                    return;
                }
                // /** @type {fs.Dir} */
                let dir_handle;
                /** @type {ReaddirCacheItem} */
                let cached_dir;
                const dir_path = path.join(this.bucket_path, dir_key);
                const prefix_dir = prefix.slice(0, dir_key.length);
                const prefix_ent = prefix.slice(dir_key.length);
                if (!dir_key.startsWith(prefix_dir)) {
                    // dbg.log0(`prefix dir does not match so no keys in this dir can apply: dir_key=${dir_key} prefix_dir=${prefix_dir}`);
                    return;
                }
                const marker_dir = key_marker.slice(0, dir_key.length);
                const marker_ent = key_marker.slice(dir_key.length);
                // marker is after dir so no keys in this dir can apply
                if (dir_key < marker_dir) {
                    // dbg.log0(`marker is after dir so no keys in this dir can apply: dir_key=${dir_key} marker_dir=${marker_dir}`);
                    return;
                }
                // when the dir portion of the marker is completely below the current dir
                // then every key in this dir satisfies the marker and marker_ent should not be used.
                const marker_curr = (marker_dir < dir_key) ? '' : marker_ent;
                // dbg.log0(`process_dir: dir_key=${dir_key} prefix_ent=${prefix_ent} marker_curr=${marker_curr}`);
                /**
                 * @typedef {{
                 *  key: string,
                 *  common_prefix: boolean
                 * }}
                 */
                const insert_entry_to_results_arr = async r => {
                    let pos;
                    // Since versions are arranged next to latest object in the latest first order,
                    // no need to find the sorted last index. Push the ".versions/#VERSION_OBJECT" as
                    // they are in order
                    if (results.length && r.key < results[results.length - 1].key &&
                        !this._is_hidden_version_path(r.key)) {
                        pos = _.sortedLastIndexBy(results, r, a => a.key);
                    } else {
                        pos = results.length;
                    }

                    if (pos >= limit) {
                        is_truncated = true;
                        return; // not added
                    }
                    if (!delimiter && r.common_prefix) {
                        await process_dir(r.key);
                    } else {
                        if (pos < results.length) {
                            results.splice(pos, 0, r);
                        } else {
                            results.push(r);
                        }
                        if (results.length > limit) {
                            results.length = limit;
                            is_truncated = true;
                        }
                    }
                };

                /**
                 * @param {fs.Dirent} ent
                 */
                const process_entry = async ent => {
                    // dbg.log0('process_entry', dir_key, ent.name);
                    if ((!ent.name.startsWith(prefix_ent) ||
                        ent.name < marker_curr ||
                        ent.name === this.get_bucket_tmpdir() ||
                        ent.name === config.NSFS_FOLDER_OBJECT_NAME) &&
                        !this._is_hidden_version_path(ent.name)) {
                        return;
                    }
                    const isDir = await is_directory_or_symlink_to_directory(ent, fs_context, path.join(dir_path, ent.name));

                    let r;
                    if (list_versions && _is_version_object(ent.name)) {
                        r = {
                            key: this._get_version_entry_key(dir_key, ent),
                            common_prefix: isDir,
                        };
                    } else {
                        r = {
                            key: this._get_entry_key(dir_key, ent, isDir),
                            common_prefix: isDir,
                        };
                    }
                    await insert_entry_to_results_arr(r);
                };

                if (!(await this.check_access(fs_context, dir_path))) return;
                try {
                    if (list_versions) {
                        cached_dir = await versions_dir_cache.get_with_cache({ dir_path, fs_context });
                    } else {
                        cached_dir = await dir_cache.get_with_cache({ dir_path, fs_context });
                    }
                } catch (err) {
                    if (err.code === 'ENOENT') {
                        dbg.log0('NamespaceFS: no keys for non existing dir', dir_path);
                        return;
                    }
                    throw err;
                }

                // insert dir object to objects list if its key is lexicographicly bigger than the key marker &&
                // no delimiter OR prefix is the current directory entry
                const is_dir_content = cached_dir.stat.xattr && cached_dir.stat.xattr[XATTR_DIR_CONTENT];
                if (is_dir_content && dir_key > key_marker && (!delimiter || dir_key === prefix)) {
                    const r = { key: dir_key, common_prefix: false };
                    await insert_entry_to_results_arr(r);
                }

                if (cached_dir.sorted_entries) {
                    const sorted_entries = cached_dir.sorted_entries;
                    let marker_index;
                    // Two ways followed here to find the index.
                    // 1. When inside marker_dir: Here the entries are sorted based on time. Here
                    //    FindIndex() is called since sortedLastIndexBy() expects sorted order by name
                    // 2. When marker_dir above dir_path: sortedLastIndexBy() is called since entries are
                    //     sorted by name
                    // 3. One of the below conditions, marker_curr.includes('/') checks whether
                    //    the call is for the directory that contains marker_curr
                    if (list_versions && marker_curr && !marker_curr.includes('/')) {
                        let start_marker = marker_curr;
                        if (version_id_marker) start_marker = version_id_marker;
                        marker_index = _.findIndex(
                            sorted_entries,
                            {name: start_marker}
                        ) + 1;
                    } else {
                        marker_index = _.sortedLastIndexBy(
                            sorted_entries,
                            make_named_dirent(marker_curr),
                            get_entry_name
                        );
                    }

                    // handling a scenario in which key_marker points to an object inside a directory
                    // since there can be entries inside the directory that will need to be pushed
                    // to results array
                    if (marker_index) {
                        const prev_dir = sorted_entries[marker_index - 1];
                        const prev_dir_name = prev_dir.name;
                        if (marker_curr.startsWith(prev_dir_name) && dir_key !== prev_dir.name) {
                            if (!delimiter) {
                                const isDir = await is_directory_or_symlink_to_directory(
                                    prev_dir, fs_context, path.join(dir_path, prev_dir_name, '/'));
                                if (isDir) {
                                    await process_dir(path.join(dir_key, prev_dir_name, '/'));
                                }
                            }
                        }
                    }
                    for (let i = marker_index; i < sorted_entries.length; ++i) {
                        const ent = sorted_entries[i];
                        if (list_versions && marker_curr) {
                            const ent_name = _get_filename(ent.name);
                            if (ent_name !== marker_curr) break;
                        }
                        // when entry is NSFS_FOLDER_OBJECT_NAME=.folder file,
                        // and the dir key marker is the name of the curr directory - skip on adding it
                        if (ent.name === config.NSFS_FOLDER_OBJECT_NAME && dir_key === marker_dir) {
                            continue;
                        }
                        await process_entry(ent);
                        // since we traverse entries in sorted order,
                        // we can break as soon as enough keys are collected.
                        if (is_truncated) break;
                    }
                    return;
                }
                // for large dirs we cannot keep all entries in memory
                // so we have to stream the entries one by one while filtering only the needed ones.
                try {
                    dbg.warn('NamespaceFS: open dir streaming', dir_path, 'size', cached_dir.stat.size);
                    dir_handle = await nb_native().fs.opendir(fs_context, dir_path); //, { bufferSize: 128 });
                    for (;;) {
                        const dir_entry = await dir_handle.read(fs_context);
                        if (!dir_entry) break;
                        await process_entry(dir_entry);
                        // since we dir entries streaming order is not sorted,
                        // we have to keep scanning all the keys before we can stop.
                    }
                    await dir_handle.close(fs_context);
                    dir_handle = null;
                } finally {
                    if (dir_handle) {
                        try {
                            dbg.warn('NamespaceFS: close dir streaming', dir_path, 'size', cached_dir.stat.size);
                            await dir_handle.close(fs_context);
                        } catch (err) {
                            dbg.error('NamespaceFS: close dir failed', err);
                        }
                        dir_handle = null;
                    }
                }
            };

            const prefix_dir_key = prefix.slice(0, prefix.lastIndexOf('/') + 1);
            await process_dir(prefix_dir_key);
            await Promise.all(results.map(async r => {
                if (r.common_prefix) return;
                const entry_path = path.join(this.bucket_path, r.key);
                //If entry is outside of bucket, returns stat of symbolic link
                const use_lstat = !(await this._is_path_in_bucket_boundaries(fs_context, entry_path));
                r.stat = await nb_native().fs.stat(fs_context, entry_path, { use_lstat });
            }));
            const res = {
                objects: [],
                common_prefixes: [],
                is_truncated,
                next_marker: undefined,
                next_version_id_marker: undefined,
            };
            for (const r of results) {
                let obj_info;
                if (r.common_prefix) {
                    res.common_prefixes.push(r.key);
                } else {
                    obj_info = this._get_object_info(bucket, r.key, r.stat, 'null', true);
                    if (!list_versions && obj_info.delete_marker) {
                        continue;
                    }
                    if (this._is_hidden_version_path(obj_info.key)) {
                        obj_info.key = path.normalize(obj_info.key.replace(HIDDEN_VERSIONS_PATH + '/', ''));
                        obj_info.key = _get_filename(obj_info.key);
                    }
                    res.objects.push(obj_info);
                }
                if (res.is_truncated) {
                    if (list_versions && _is_version_object(r.key)) {
                        const next_version_id_marker = r.key.substring(r.key.lastIndexOf('/') + 1);
                        res.next_version_id_marker = next_version_id_marker;
                        res.next_marker = _get_filename(next_version_id_marker);
                    } else {
                        res.next_marker = r.key;
                    }
                }
            }
            return res;
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }

    /////////////////
    // OBJECT READ //
    /////////////////

    async read_object_md(params, object_sdk) {
        const fs_context = this.prepare_fs_context(object_sdk);
        try {
            const file_path = await this._find_version_path(fs_context, params, true);
            await this._check_path_in_bucket_boundaries(fs_context, file_path);
            await this._load_bucket(params, fs_context);
            const stat = await nb_native().fs.stat(fs_context, file_path);
            this._throw_if_delete_marker(stat);
            return this._get_object_info(params.bucket, params.key, stat, params.version_id || 'null');
        } catch (err) {
            this.run_update_issues_report(object_sdk, err);
            throw this._translate_object_error_codes(err);
        }
    }

    // eslint-disable-next-line max-statements
    async read_object_stream(params, object_sdk, res) {
        let file;
        let buffer_pool_cleanup = null;
        const fs_context = this.prepare_fs_context(object_sdk);
        let file_path;
        try {
            await this._load_bucket(params, fs_context);
            file_path = await this._find_version_path(fs_context, params);
            await this._check_path_in_bucket_boundaries(fs_context, file_path);

            // NOTE: don't move this code after the open
            // this can lead to ENOENT failures due to file not exists when content size is 0
            // if entry is a directory object and its content size = 0 - return empty response
            const is_dir_content = this._is_directory_content(file_path, params.key);
            if (is_dir_content) {
                try {
                    const md_path = this._get_file_md_path(params);
                    const dir_stat = await nb_native().fs.stat(fs_context, md_path);
                    if (dir_stat && dir_stat.xattr[XATTR_DIR_CONTENT] === '0') return null;
                } catch (err) {
                    dbg.log0('NamespaceFS: read_object_stream couldnt find dir content xattr', err);
                }
            }

            file = await nb_native().fs.open(
                fs_context,
                file_path,
                config.NSFS_OPEN_READ_MODE,
                get_umasked_mode(config.BASE_MODE_FILE),
            );

            const stat = await file.stat(fs_context);
            this._throw_if_delete_marker(stat);
            // await this._fail_if_archived_or_sparse_file(fs_context, file_path, stat);

            const start = Number(params.start) || 0;
            const end = isNaN(Number(params.end)) ? Infinity : Number(params.end);

            let num_bytes = 0;
            let num_buffers = 0;
            const log2_size_histogram = {};
            let drain_promise = null;

            dbg.log0('NamespaceFS: read_object_stream', {
                file_path, start, end, size: stat.size,
            });

            let count = 1;
            for (let pos = start; pos < end;) {
                object_sdk.throw_if_aborted();

                // Our buffer pool keeps large buffers and we want to avoid spending
                // all our large buffers and then have them waiting for high latency calls
                // such as reading from archive/on-demand cache files.
                // Instead, we detect the case where a file is "sparse",
                // and then use just a small buffer to wait for a tiny read,
                // which will recall the file from archive or load from remote into cache,
                // and once it returns we can continue to the full fledged read.
                if (config.NSFS_BUF_WARMUP_SPARSE_FILE_READS && is_sparse_file(stat)) {
                    dbg.log0('NamespaceFS: read_object_stream - warmup sparse file', {
                        file_path, pos, size: stat.size, blocks: stat.blocks,
                    });
                    await file.read(fs_context, this.warmup_buffer, 0, 1, pos);
                }

                // allocate or reuse buffer
                // TODO buffers_pool and the underlying semaphore should support abort signal
                // to avoid sleeping inside the semaphore until the timeout while the request is already aborted.
                const { buffer, callback } = await buffers_pool.get_buffer();
                buffer_pool_cleanup = callback; // must be called ***IMMEDIATELY*** after get_buffer
                object_sdk.throw_if_aborted();

                // read from file
                const remain_size = Math.max(0, end - pos);
                const read_size = Math.min(buffer.length, remain_size);

                const bytesRead = await file.read(fs_context, buffer, 0, read_size, pos);
                if (!bytesRead) {
                    buffer_pool_cleanup = null;
                    callback();
                    break;
                }
                object_sdk.throw_if_aborted();
                const data = buffer.slice(0, bytesRead);

                // update stats
                pos += bytesRead;
                num_bytes += bytesRead;
                num_buffers += 1;
                const log2_size = Math.ceil(Math.log2(bytesRead));
                log2_size_histogram[log2_size] = (log2_size_histogram[log2_size] || 0) + 1;

                // collect read stats
                this.stats?.update_nsfs_read_stats({
                    namespace_resource_id: this.namespace_resource_id,
                    bucket_name: params.bucket,
                    size: bytesRead,
                    count
                });
                // clear count for next updates
                count = 0;

                // wait for response buffer to drain before adding more data if needed -
                // this occurs when the output network is slower than the input file
                if (drain_promise) {
                    await drain_promise;
                    drain_promise = null;
                    object_sdk.throw_if_aborted();
                }

                // write the data out to response
                buffer_pool_cleanup = null; // cleanup is now in the socket responsibility
                const write_ok = res.write(data, null, callback);
                if (!write_ok) {
                    drain_promise = stream_utils.wait_drain(res, { signal: object_sdk.abort_controller.signal });
                    drain_promise.catch(() => undefined); // this avoids UnhandledPromiseRejection
                }
            }

            await file.close(fs_context);
            file = null;
            object_sdk.throw_if_aborted();

            // wait for the last drain if pending.
            if (drain_promise) {
                await drain_promise;
                drain_promise = null;
                object_sdk.throw_if_aborted();
            }

            // end the stream
            res.end();

            await stream_utils.wait_finished(res, { signal: object_sdk.abort_controller.signal });
            object_sdk.throw_if_aborted();

            dbg.log0('NamespaceFS: read_object_stream completed file', file_path, {
                num_bytes,
                num_buffers,
                avg_buffer: num_bytes / num_buffers,
                log2_size_histogram,
            });

            // return null to signal the caller that we already handled the response
            return null;

        } catch (err) {
            dbg.log0('NamespaceFS: read_object_stream error file', file_path, err);
            throw this._translate_object_error_codes(err);

        } finally {
            try {
                if (file) {
                    dbg.log0('NamespaceFS: read_object_stream finally closing file', file_path);
                    await file.close(fs_context);
                }
            } catch (err) {
                dbg.warn('NamespaceFS: read_object_stream file close error', err);
            }
            try {
                // release buffer back to pool if needed
                if (buffer_pool_cleanup) {
                    dbg.log0('NamespaceFS: read_object_stream finally buffer_pool_cleanup', file_path);
                    buffer_pool_cleanup();
                }
            } catch (err) {
                dbg.warn('NamespaceFS: read_object_stream buffer pool cleanup error', err);
            }
        }
    }


    ///////////////////
    // OBJECT UPLOAD //
    ///////////////////

    async upload_object(params, object_sdk) {
        const fs_context = this.prepare_fs_context(object_sdk);
        await this._load_bucket(params, fs_context);
        const open_mode = this._is_gpfs(fs_context) ? 'wt' : 'w';
        const file_path = this._get_file_path(params);
        let upload_params;
        try {
            await this._check_path_in_bucket_boundaries(fs_context, file_path);

            if (this.empty_dir_content_flow(file_path, params)) {
                const content_dir_info = await this._create_empty_dir_content(fs_context, params, file_path);
                return content_dir_info;
            }

            upload_params = await this._start_upload(fs_context, object_sdk, file_path, params, open_mode);

            if (!params.copy_source || upload_params.copy_res === copy_status_enum.FALLBACK) {
            // TODO: Take up only as much as we need (requires fine-tune of the semaphore inside the _upload_stream)
            // Currently we are taking config.NSFS_BUF_SIZE for any sized upload (1KB upload will take a full buffer from semaphore)
                upload_params.digest = await buffers_pool_sem.surround_count(
                    config.NSFS_BUF_SIZE, async () => this._upload_stream(upload_params));
            }
            const upload_info = await this._finish_upload(upload_params);
            return upload_info;
        } catch (err) {
            this.run_update_issues_report(object_sdk, err);
            throw this._translate_object_error_codes(err);
        } finally {
            try {
                if (upload_params && upload_params.target_file) await upload_params.target_file.close(fs_context);
            } catch (err) {
                dbg.warn('NamespaceFS: upload_object file close error', err);
            }
        }
    }

    // creates upload_path if needed
    // on copy will call try_copy_file() or fallback
    // and opens upload_path (if exists) or file_path
    // returns upload params - params that are passed to the called functions in upload_object
    async _start_upload(fs_context, object_sdk, file_path, params, open_mode) {
        let upload_path;
        // upload path is needed only when open_mode is w / for copy
        if (open_mode === 'w' || params.copy_source) {
            const upload_id = uuidv4();
            upload_path = path.join(this.bucket_path, this.get_bucket_tmpdir(), 'uploads', upload_id);
            await this._make_path_dirs(upload_path, fs_context);
        }
        let open_path = upload_path || file_path;

        const copy_res = params.copy_source && (await this._try_copy_file(fs_context, params, file_path, upload_path));
        if (copy_res) {
            if (copy_res === copy_status_enum.FALLBACK) {
                params.copy_source.nsfs_copy_fallback();
            } else {
                // open file after copy link/same inode should use read open mode
                open_mode = config.NSFS_OPEN_READ_MODE;
                if (copy_res === copy_status_enum.SAME_INODE) open_path = file_path;
            }
        }
        const target_file = await this._open_file(fs_context, open_path, open_mode);
        return { fs_context, params, object_sdk, open_mode, file_path, upload_path, target_file, copy_res };
    }

    // opens open_path on POSIX, and on GPFS it will open open_path parent folder
    async _open_file(fs_context, open_path, open_mode = config.NSFS_OPEN_READ_MODE) {
        const dir_path = path.dirname(open_path);
        if ((open_mode === 'wt' || open_mode === 'w') && dir_path !== this.bucket_path) {
            dbg.log1(`NamespaceFS._open_file: mode=${open_mode} creating dirs`, open_path, this.bucket_path);
            await this._make_path_dirs(open_path, fs_context);
        }
        dbg.log0(`NamespaceFS._open_file: mode=${open_mode}`, open_path);
        // for 'wt' open the tmpfile with the parent dir path
        const actual_open_path = open_mode === 'wt' ? dir_path : open_path;
        return nb_native().fs.open(fs_context, actual_open_path, open_mode, get_umasked_mode(config.BASE_MODE_FILE));
    }

    // on server side copy -
    // 1. check if source and target is same inode and return if do nothing if true, status is SAME_INODE
    // 2. else we try link - on link success, status is LINKED
    // 3. if link failed - status is fallback - read the stream from the source and upload it as regular upload
    // on non server side copy - we will immediatly do the fallback
    async _try_copy_file(fs_context, params, file_path, upload_path) {
        const source_file_path = await this._find_version_path(fs_context, params.copy_source);
        await this._check_path_in_bucket_boundaries(fs_context, source_file_path);
        // await this._fail_if_archived_or_sparse_file(fs_context, source_file_path, stat);
        let res = copy_status_enum.FALLBACK;
        if (this._is_versioning_disabled()) {
            try {
                // indicates a retry situation in which the source and target point to the same inode
                const same_inode = await this._is_same_inode(fs_context, source_file_path, file_path);
                if (same_inode) return copy_status_enum.SAME_INODE;
                // Doing a hard link.
                await nb_native().fs.link(fs_context, source_file_path, upload_path);
                res = copy_status_enum.LINKED;
            } catch (e) {
                dbg.warn('NamespaceFS: COPY using link failed with:', e);
            }
        }
        return res;
    }

    // on put part - file path is equal to upload path
    // put part upload should NOT contain -  versioning & move to dest steps
    // if copy status is SAME_INODE - NO xattr replace/move_to_dest
    // if copy status is LINKED - NO xattr replace
    // xattr_copy = false implies on non server side copy fallback copy (copy status = FALLBACK)
    // target file can be undefined when it's a folder created and size is 0
    async _finish_upload({ fs_context, params, open_mode, target_file, upload_path, file_path, digest = undefined,
            copy_res = undefined }) {
        const part_upload = file_path === upload_path;
        const same_inode = params.copy_source && copy_res === copy_status_enum.SAME_INODE;
        const is_dir_content = this._is_directory_content(file_path, params.key);

        let stat = await target_file.stat(fs_context);
        this._verify_encryption(params.encryption, this._get_encryption_info(stat));

        let fs_xattr;
        // handle xattr
        if (!params.copy_source || !params.xattr_copy) {
            fs_xattr = to_fs_xattr(params.xattr);
            if (params.content_type) {
                fs_xattr = fs_xattr || {};
                fs_xattr[XATTR_CONTENT_TYPE] = params.content_type;
            }
            if (digest) {
                const { md5_b64, key, bucket, upload_id } = params;
                if (md5_b64) {
                    const md5_hex = Buffer.from(md5_b64, 'base64').toString('hex');
                    if (md5_hex !== digest) throw new Error('_upload_stream mismatch etag: ' + util.inspect({ key, bucket, upload_id, md5_hex, digest }));
                }
                fs_xattr = this._assign_md5_to_fs_xattr(digest, fs_xattr);
            }
            if (!part_upload && (this._is_versioning_enabled() || this._is_versioning_suspended())) {
                const cur_ver_info = await this._get_version_info(fs_context, file_path);
                fs_xattr = await this._assign_versions_to_fs_xattr(fs_context, cur_ver_info, stat, params.key, fs_xattr);
            }
            if (fs_xattr && !is_dir_content) await target_file.replacexattr(fs_context, fs_xattr);
        }
        // fsync
        if (config.NSFS_TRIGGER_FSYNC) await target_file.fsync(fs_context);
        dbg.log1('NamespaceFS._finish_upload:', open_mode, file_path, upload_path, fs_xattr);

        if (!same_inode && !part_upload) {
            await this._move_to_dest(fs_context, upload_path, file_path, target_file, open_mode, params.key);
            if (config.NSFS_TRIGGER_FSYNC) await nb_native().fs.fsync(fs_context, path.dirname(file_path));
        }

        // when object is a dir, xattr are set on the folder itself and the content is in .folder file
        if (is_dir_content) await this._assign_dir_content_to_xattr(fs_context, fs_xattr, { ...params, size: stat.size });

        stat = await nb_native().fs.stat(fs_context, file_path);
        const upload_info = this._get_upload_info(stat, fs_xattr && fs_xattr[XATTR_VERSION_ID]);
        return upload_info;
    }

    async _create_empty_dir_content(fs_context, params, file_path) {
        await this._make_path_dirs(file_path, fs_context);

        const fs_xattr = to_fs_xattr(params.xattr);
        await this._assign_dir_content_to_xattr(fs_context, fs_xattr, params);
        // when .folder exist and it's no upload flow - .folder should be deleted if it exists
        try {
           await nb_native().fs.unlink(fs_context, file_path);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            dbg.log0(`namespace_fs._create_empty_dir_content: dir object file ${config.NSFS_FOLDER_OBJECT_NAME} was already deleted`);
        }
        const dir_path = this._get_file_md_path(params);
        const stat = await nb_native().fs.stat(fs_context, dir_path);
        const upload_info = this._get_upload_info(stat, fs_xattr && fs_xattr[XATTR_VERSION_ID]);
        return upload_info;
    }


    // move to dest GPFS (wt) / POSIX (w / undefined) - non part upload
    async _move_to_dest(fs_context, source_path, dest_path, target_file, open_mode, key) {
        let retries = config.NSFS_RENAME_RETRIES;
        // will retry renaming a file in case of parallel deleting of the destination path
        for (;;) {
            try {
                await this._make_path_dirs(dest_path, fs_context);
                if (this._is_versioning_disabled()) {
                    if (open_mode === 'wt') {
                        await target_file.linkfileat(fs_context, dest_path);
                    } else {
                        await nb_native().fs.rename(fs_context, source_path, dest_path);
                    }
                } else {
                    await this._move_to_dest_version(fs_context, source_path, dest_path, target_file, key, open_mode);
                }
                break;
            } catch (err) {
                retries -= 1;
                if (retries <= 0) throw err;
                if (err.code !== 'ENOENT') throw err;
                // checking that the source_path still exists
                // TODO: handle tmp file - source_path is missing
                if (source_path && !await this.check_access(fs_context, source_path)) throw err;
                dbg.warn(`NamespaceFS: Retrying failed move to dest retries=${retries}` +
                    ` source_path=${source_path} dest_path=${dest_path}`, err);
            }
        }
    }

    // 1. get latest version_id
    // 2. if versioning is suspended - 
    //     2.1 if version ID of the latest version is null - 
    //       2.1.1 remove latest version
    //     2.2 else (version ID of the latest version is unique or there is no latest version) -
    //       2.2.1 remove a version (or delete marker) with null version ID from .versions/ (if exists)
    //  3. if latest version exists -
    //     versioning is enabled
    //     OR
    //     versioning is suspended AND latest version is a unique id (not null version)
    //       3.2 create .versions/ if it doesn't exist
    //       3.3 move latest version to .versions/
    // 4. move new version to latest_ver_path (key path)
    // retry safe linking a file in case of parallel put/delete of the source path
    async _move_to_dest_version(fs_context, new_ver_tmp_path, latest_ver_path, upload_file, key, open_mode) {
        dbg.log1('Namespace_fs._move_to_dest_version:', new_ver_tmp_path, latest_ver_path, upload_file);
        let gpfs_options;
        const is_gpfs = this._is_gpfs(fs_context);
        let retries = config.NSFS_RENAME_RETRIES;
        for (;;) {
            try {
                const new_ver_info = !is_gpfs && await this._get_version_info(fs_context, new_ver_tmp_path);
                // get latest version_id if exists
                const latest_ver_info = await this._get_version_info(fs_context, latest_ver_path);
                const versioned_path = latest_ver_info && this._get_version_path(key, latest_ver_info.version_id_str);
                const versioned_info = latest_ver_info && await this._get_version_info(fs_context, versioned_path);

                gpfs_options = is_gpfs ?
                    await this._open_files_gpfs(fs_context, new_ver_tmp_path, latest_ver_path, upload_file,
                        latest_ver_info, open_mode, undefined, versioned_info) :
                    undefined;

                dbg.log1('Namespace_fs._move_to_dest_version:', latest_ver_info, new_ver_info, gpfs_options);

                if (this._is_versioning_suspended()) {
                    if (latest_ver_info?.version_id_str === NULL_VERSION_ID) {
                        dbg.log1('NamespaceFS._move_to_dest_version suspended: version ID of the latest version is null - the file will be unlinked');
                        await this.safe_unlink(fs_context, latest_ver_path, latest_ver_info, gpfs_options);
                    } else {
                        // remove a version (or delete marker) with null version ID from .versions/ (if exists)
                        await this._delete_null_version_from_versions_directory(key, fs_context);
                    }
                }
                if (latest_ver_info &&
                    ((this._is_versioning_enabled()) ||
                        (this._is_versioning_suspended() && latest_ver_info.version_id_str !== NULL_VERSION_ID))) {
                    dbg.log1('NamespaceFS._move_to_dest_version version ID of the latest version is a unique ID - the file will be moved it to .versions/ directory');
                    await this._make_path_dirs(versioned_path, fs_context);
                    await this.safe_move(fs_context, latest_ver_path, versioned_path, latest_ver_info,
                        gpfs_options && gpfs_options.move_to_versions);
                }
                try {
                    // move new version to latest_ver_path (key path)
                    await this.safe_move(fs_context, new_ver_tmp_path, latest_ver_path, new_ver_info,
                        gpfs_options && gpfs_options.move_to_dst);
                } catch (err) {
                    if (err.message !== posix_unlink_retry_err && err.code !== gpfs_unlink_retry_catch) throw err;
                    dbg.warn('Namespace_fs._move_to_dest_version: unable to delete new version tmp file, ignoring...');
                }
                break;
            } catch (err) {
                retries -= 1;
                if (retries <= 0 || !this.should_retry_link_unlink(is_gpfs, err)) throw err;
                dbg.warn(`NamespaceFS._move_to_dest_version retrying retries=${retries}` +
                    ` new_ver_tmp_path=${new_ver_tmp_path} latest_ver_path=${latest_ver_path}`, err);
            } finally {
                if (gpfs_options) await this._close_files_gpfs(fs_context, gpfs_options.move_to_dst, open_mode);
            }
        }
    }

    // Comparing both device and inode number (st_dev and st_ino returned by stat)
    // will tell you whether two different file names refer to the same thing.
    // If so, we will return the etag and encryption info of the file_path
    async _is_same_inode(fs_context, source_file_path, file_path) {
        try {
            dbg.log2('NamespaceFS: checking _is_same_inode');
            const file_path_stat = await nb_native().fs.stat(fs_context, file_path);
            const file_path_inode = file_path_stat.ino.toString();
            const file_path_device = file_path_stat.dev.toString();
            const source_file_stat = await nb_native().fs.stat(fs_context, source_file_path, { skip_user_xattr: true });
            const source_file_inode = source_file_stat.ino.toString();
            const source_file_device = source_file_stat.dev.toString();
            dbg.log2('NamespaceFS: file_path_inode:', file_path_inode, 'source_file_inode:', source_file_inode,
                'file_path_device:', file_path_device, 'source_file_device:', source_file_device);
            if (file_path_inode === source_file_inode && file_path_device === source_file_device) {
                return file_path_stat;
            }
        } catch (e) {
            dbg.log2('NamespaceFS: _is_same_inode got an error', e);
            // If we fail for any reason, we want to return undefined. so doing nothing in this catch.
        }
    }

    // Allocated config.NSFS_BUF_SIZE in Semaphore but in fact we can take up more inside
    // This is due to MD5 calculation and data buffers
    // Can be finetuned further on if needed and inserting the Semaphore logic inside
    // Instead of wrapping the whole _upload_stream function (q_buffers lives outside of the data scope of the stream)
    async _upload_stream({ fs_context, params, target_file, object_sdk }) {
        const { source_stream } = params;
        try {
            // Not using async iterators with ReadableStreams due to unsettled promises issues on abort/destroy
            const md5_enabled = config.NSFS_CALCULATE_MD5 || (this.force_md5_etag ||
                object_sdk?.requesting_account?.force_md5_etag);
            const chunk_fs = new ChunkFS({
                target_file,
                fs_context,
                stats: this.stats,
                namespace_resource_id: this.namespace_resource_id,
                md5_enabled
            });
            chunk_fs.on('error', err1 => dbg.error('namespace_fs._upload_stream: error occured on stream ChunkFS: ', err1));
            await stream_utils.pipeline([source_stream, chunk_fs]);
            await stream_utils.wait_finished(chunk_fs);
            return chunk_fs.digest;
        } catch (error) {
            dbg.error('_upload_stream had error: ', error);
            throw error;
        }
    }


    //////////////////////
    // MULTIPART UPLOAD //
    //////////////////////

    async list_uploads(params, object_sdk) {
        // TODO for now we do not support listing of multipart uploads
        return {
            objects: [],
            common_prefixes: [],
            is_truncated: false,
            next_marker: undefined,
            next_upload_id_marker: undefined,
        };
    }

    async create_object_upload(params, object_sdk) {
        try {
            const fs_context = this.prepare_fs_context(object_sdk);
            await this._load_bucket(params, fs_context);
            params.obj_id = uuidv4();
            params.mpu_path = this._mpu_path(params);
            await this._create_path(params.mpu_path, fs_context);
            const create_params = JSON.stringify({ ...params, source_stream: null });
            await nb_native().fs.writeFile(
                fs_context,
                path.join(params.mpu_path, 'create_object_upload'),
                Buffer.from(create_params), {
                    mode: get_umasked_mode(config.BASE_MODE_FILE)
                }
            );
            return { obj_id: params.obj_id };
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }

    async upload_multipart(params, object_sdk) {
        // We can use 'wt' for open mode like we do for upload_object() when
        // we figure out how to create multipart upload using temp files.
        const open_mode = 'w';
        const fs_context = this.prepare_fs_context(object_sdk);
        let target_file;
        try {
            await this._load_multipart(params, fs_context);
            const upload_path = path.join(params.mpu_path, `part-${params.num}`);
            // Will get populated in _upload_stream with the MD5 (if MD5 calculation is enabled)
            target_file = await this._open_file(fs_context, upload_path, open_mode);
            const upload_params = { fs_context, params, object_sdk, upload_path, open_mode, target_file, file_path: upload_path };

            await buffers_pool_sem.surround_count(config.NSFS_BUF_SIZE, async () => this._upload_stream(upload_params));

            const upload_info = await this._finish_upload(upload_params);
            return upload_info;
        } catch (err) {
            this.run_update_issues_report(object_sdk, err);
            throw this._translate_object_error_codes(err);
        } finally {
            try {
                if (target_file) await target_file.close(fs_context);
            } catch (err) {
                dbg.warn('NamespaceFS: _upload_stream file close error', err);
            }
        }
    }

    async list_multiparts(params, object_sdk) {
        try {
            const fs_context = this.prepare_fs_context(object_sdk);
            await this._load_multipart(params, fs_context);
            await this._check_path_in_bucket_boundaries(fs_context, params.mpu_path);
            const entries = await nb_native().fs.readdir(fs_context, params.mpu_path);
            const multiparts = await Promise.all(
                entries
                .filter(e => e.name.startsWith('part-'))
                .map(async e => {
                    const num = Number(e.name.slice('part-'.length));
                    const part_path = path.join(params.mpu_path, e.name);
                    const stat = await nb_native().fs.stat(fs_context, part_path);
                    return {
                        num,
                        size: stat.size,
                        etag: this._get_etag(stat),
                        last_modified: new Date(stat.mtime),
                    };
                })
            );
            return {
                is_truncated: false,
                next_num_marker: undefined,
                multiparts,
            };
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }

    async complete_object_upload(params, object_sdk) {
        let read_file;
        let target_file;
        let buffer_pool_cleanup = null;
        const fs_context = this.prepare_fs_context(object_sdk);
        const open_mode = 'w';
        try {
            const md5_enabled = config.NSFS_CALCULATE_MD5 || (this.force_md5_etag ||
                object_sdk?.requesting_account?.force_md5_etag);
            const MD5Async = md5_enabled ? new (nb_native().crypto.MD5Async)() : undefined;
            const { multiparts = [] } = params;
            multiparts.sort((a, b) => a.num - b.num);
            await this._load_multipart(params, fs_context);
            const file_path = this._get_file_path(params);
            await this._check_path_in_bucket_boundaries(fs_context, file_path);
            const upload_path = path.join(params.mpu_path, 'final');
            target_file = await this._open_file(fs_context, upload_path, open_mode);
            const upload_params = { fs_context, upload_path, open_mode, file_path, params, target_file };

            for (const { num, etag } of multiparts) {
                const part_path = path.join(params.mpu_path, `part-${num}`);
                read_file = await this._open_file(fs_context, part_path, config.NSFS_OPEN_READ_MODE);
                const part_stat = await read_file.stat(fs_context);

                if (etag !== this._get_etag(part_stat)) {
                    throw new Error('mismatch part etag: ' + util.inspect({ num, etag, part_path, part_stat, params }));
                }

                let read_pos = 0;
                for (;;) {
                    const { buffer, callback } = await buffers_pool.get_buffer();
                    buffer_pool_cleanup = callback;
                    const bytesRead = await read_file.read(fs_context, buffer, 0, config.NSFS_BUF_SIZE, read_pos);
                    if (!bytesRead) {
                        buffer_pool_cleanup = null;
                        callback();
                        break;
                    }
                    read_pos += bytesRead;
                    const data = buffer.slice(0, bytesRead);
                    await target_file.write(fs_context, data);
                    // Returns the buffer to pool to avoid starvation
                    buffer_pool_cleanup = null;
                    callback();
                }

                await read_file.close(fs_context);
                read_file = null;
                if (MD5Async) await MD5Async.update(Buffer.from(etag, 'hex'));
            }

            const { data: create_params_buffer } = await nb_native().fs.readFile(
                fs_context,
                path.join(params.mpu_path, 'create_object_upload')
            );
            upload_params.params.xattr = (JSON.parse(create_params_buffer.toString())).xattr;
            upload_params.digest = MD5Async && (((await MD5Async.digest()).toString('hex')) + '-' + multiparts.length);
            const upload_info = await this._finish_upload(upload_params);

            await target_file.close(fs_context);
            target_file = null;
            if (config.NSFS_REMOVE_PARTS_ON_COMPLETE) await this._folder_delete(params.mpu_path, fs_context);

            return upload_info;
        } catch (err) {
            dbg.error(err);
            throw this._translate_object_error_codes(err);
        } finally {
            await this.complete_object_upload_finally(buffer_pool_cleanup, read_file, target_file, fs_context);
        }
    }

    // complete_object_upload method has too many statements
    async complete_object_upload_finally(buffer_pool_cleanup, read_file, write_file, fs_context) {
        try {
            // release buffer back to pool if needed
            if (buffer_pool_cleanup) buffer_pool_cleanup();
        } catch (err) {
            dbg.warn('NamespaceFS: complete_object_upload buffer pool cleanup error', err);
        }
        try {
            if (read_file) await read_file.close(fs_context);
        } catch (err) {
            dbg.warn('NamespaceFS: complete_object_upload read file close error', err);
        }
        try {
            if (write_file) await write_file.close(fs_context);
        } catch (err) {
            dbg.warn('NamespaceFS: complete_object_upload write file close error', err);
        }
    }

    async abort_object_upload(params, object_sdk) {
        const fs_context = this.prepare_fs_context(object_sdk);
        await this._load_multipart(params, fs_context);
        dbg.log0('NamespaceFS: abort_object_upload', params.mpu_path);
        await this._folder_delete(params.mpu_path, fs_context);
    }

    ///////////////////
    // OBJECT DELETE //
    ///////////////////

    async delete_object(params, object_sdk) {
        try {
            const fs_context = this.prepare_fs_context(object_sdk);
            await this._load_bucket(params, fs_context);
            const file_path = await this._find_version_path(fs_context, params);
            await this._check_path_in_bucket_boundaries(fs_context, file_path);
            dbg.log0('NamespaceFS: delete_object', file_path);
            let res;
            if (this._is_versioning_disabled()) {
                await this._delete_single_object(fs_context, file_path, params);
            } else {
                res = params.version_id ?
                    await this._delete_version_id(fs_context, file_path, params) :
                    await this._delete_latest_version(fs_context, file_path, params);
            }
            return res || {};
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }


    async delete_multiple_objects(params, object_sdk) {
        try {
            const fs_context = this.prepare_fs_context(object_sdk);
            await this._load_bucket(params, fs_context);
            let res = [];
            if (this._is_versioning_disabled()) {
                for (const { key, version } of params.objects) {
                    if (version) {
                        res.push({});
                        continue;
                    }
                    try {
                        const file_path = this._get_file_path({ key });
                        await this._check_path_in_bucket_boundaries(fs_context, file_path);
                        dbg.log1('NamespaceFS: delete_multiple_objects', file_path);
                        await this._delete_single_object(fs_context, file_path, { key });
                        res.push({ key });
                    } catch (err) {
                        res.push({ err_code: err.code, err_message: err.message });
                    }
                }
            } else {
                // [{key: a, version: 1}, {key: a, version: 2}, {key:b, version: 1}] => {'a': [1, 2], 'b': [1]}
                const versions_by_key_map = {};
                for (const { key, version_id } of params.objects) {
                    if (versions_by_key_map[key]) versions_by_key_map[key].push(version_id);
                    else versions_by_key_map[key] = [version_id];
                }
                dbg.log3('NamespaceFS: versions_by_key_map', versions_by_key_map);
                for (const key of Object.keys(versions_by_key_map)) {
                    const key_res = await this._delete_objects_versioned(fs_context, key, versions_by_key_map[key]);
                    res = res.concat(key_res);
                }
            }
            return res;
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }


    async _delete_single_object(fs_context, file_path, params) {
        try {
            await nb_native().fs.unlink(fs_context, file_path);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        await this._delete_path_dirs(file_path, fs_context);
        // when deleting the data of a directory object, we need to remove the directory dir object xattr
        // if the dir still exists - occurs when deleting dir while the dir still has entries in it
        if (this._is_directory_content(file_path, params.key)) await this._clear_user_xattr(fs_context, this._get_file_md_path(params));
    }

    ///////////////////////
    // OBJECT VERSIONING //
    ///////////////////////

    async set_bucket_versioning(versioning, object_sdk) {
        if (!config.NSFS_VERSIONING_ENABLED) throw new RpcError('BAD_REQUEST', 'nsfs versioning is unsupported');
        try {
            const fs_context = this.prepare_fs_context(object_sdk);
            await nb_native().fs.checkAccess(fs_context, this.bucket_path);
            this.versioning = versioning;
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }

    ////////////////////
    // OBJECT TAGGING //
    ////////////////////

    async get_object_tagging(params, object_sdk) {
        // TODO
        return { tagging: [] };
    }
    async delete_object_tagging(params, object_sdk) {
        // TODO
        return {};
    }
    async put_object_tagging(params, object_sdk) {
        // TODO
        return { tagging: [] };
    }

    //////////////////////////
    // AZURE BLOB MULTIPART //
    //////////////////////////

    async upload_blob_block(params, object_sdk) {
        throw new Error('TODO');
    }
    async commit_blob_block_list(params, object_sdk) {
        throw new Error('TODO');
    }
    async get_blob_block_lists(params, object_sdk) {
        throw new Error('TODO');
    }

    //////////
    // ACLs //
    //////////

    async get_object_acl(params, object_sdk) {
        await this.read_object_md(params, object_sdk);
        return s3_utils.DEFAULT_OBJECT_ACL;
    }

    async put_object_acl(params, object_sdk) {
        await this.read_object_md(params, object_sdk);
    }

    ///////////////////
    //  OBJECT LOCK  //
    ///////////////////

    async get_object_legal_hold() {
        throw new Error('TODO');
    }
    async put_object_legal_hold() {
        throw new Error('TODO');
    }
    async get_object_retention() {
        throw new Error('TODO');
    }
    async put_object_retention() {
        throw new Error('TODO');
    }

    ///////////////
    // INTERNALS //
    ///////////////

    _get_file_path({key}) {
        // not allowing keys with dots follow by slash which can be treated as relative paths and "leave" the bucket_path
        // We are not using `path.isAbsolute` as path like '/../..' will return true and we can still "leave" the bucket_path
        if (key.includes('./')) throw new Error('Bad relative path key ' + key);

        // using normalize to get rid of multiple slashes in the middle of the path (but allows single trailing /)
        const p = path.normalize(path.join(this.bucket_path, key));

        // when the key refers to a directory (trailing /) we append a unique entry name
        // so that we can upload/download the object content to that dir entry.
        return p.endsWith('/') ? p + config.NSFS_FOLDER_OBJECT_NAME : p;
    }

    _get_file_md_path({ key }) {
        const p = this._get_file_path({ key });
        // when the key refers to a directory (trailing /) but we would like to return the md path
        // we return the parent directory of .folder
        return this._is_directory_content(p, key) ? path.join(path.dirname(p), '/') : p;
    }

    _assign_md5_to_fs_xattr(md5_digest, fs_xattr) {
        // TODO: Assign content_md5_mtime
        fs_xattr = Object.assign(fs_xattr || {}, {
            [XATTR_MD5_KEY]: md5_digest
        });
        return fs_xattr;
    }

    async _assign_versions_to_fs_xattr(fs_context, prev_ver_info, new_ver_stat, key, fs_xattr, delete_marker) {
        if (!prev_ver_info) prev_ver_info = await this.find_max_version_past(fs_context, key);

        fs_xattr = Object.assign(fs_xattr || {}, {
            [XATTR_VERSION_ID]: this._get_version_id_by_mode(new_ver_stat)
        });

        if (prev_ver_info) fs_xattr[XATTR_PREV_VERSION_ID] = prev_ver_info.version_id_str;
        if (delete_marker) fs_xattr[XATTR_DELETE_MARKER] = delete_marker;

        return fs_xattr;
    }

    /**
     * 
     * @param {*} fs_context - fs context object
     * @param {string} file_path - path to file
     * @param {*} set - the xattr object to be set
     * @param {*} clear - the xattr prefix to be cleared
     * @returns {Promise<void>}
     */
    async set_fs_xattr_op(fs_context, file_path, set, clear) {
        let file;
        try {
            file = await nb_native().fs.open(fs_context, file_path, config.NSFS_OPEN_READ_MODE, get_umasked_mode(config.BASE_MODE_FILE));
            await file.replacexattr(fs_context, set, clear);
            await file.close(fs_context);
            file = null;
        } catch (error) {
            dbg.error('namespace_fs.handle_fs_xattr_op: failed with error: ', error, file_path);
            throw this._translate_object_error_codes(error);
        } finally {
            if (file) await file.close(fs_context);
        }
    }

    /**
     *
     * @param {*} fs_context - fs context object
     * @param {string} file_path - file to path to be xattr cleared
     * @returns {Promise<void>}
    */
    async _clear_user_xattr(fs_context, file_path) {
        try {
            await this.set_fs_xattr_op(fs_context, file_path, undefined, XATTR_USER_PREFIX);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            dbg.log0(`namespace_fs._clear_user_xattr: dir ${file_path} was already deleted`);
        }
    }

    /**
     *
     * @param {*} fs_context - fs context object
     * @param {object} fs_xattr - fs_xattr object to be set on a directory
     * @param {object} params - upload object params
     * @returns {Promise<void>}
     * assigns XATTR_DIR_CONTENT xattr to the fs_xattr object of the file and set to the directory
     * existing xattr starting with XATTR_USER_PREFIX will be cleared
    */
    async _assign_dir_content_to_xattr(fs_context, fs_xattr, params) {
        const dir_path = this._get_file_md_path(params);
        fs_xattr = Object.assign(fs_xattr || {}, {
            [XATTR_DIR_CONTENT]: params.size || 0
        });
        await this.set_fs_xattr_op(fs_context, dir_path, fs_xattr, XATTR_USER_PREFIX);
    }

    /**
     *
     * @param {string} file_path - fs context object
     * @param {string} key - fs_xattr object to be set on a directory
     * @returns {boolean} - describes if the file path describe a directory content
    */
    _is_directory_content(file_path, key) {
        return (file_path && file_path.endsWith(config.NSFS_FOLDER_OBJECT_NAME)) && (key && key.endsWith('/'));
    }

    /**
     * @param {string} dir_key
     * @param {fs.Dirent} ent
     * @returns {string}
     */
    _get_entry_key(dir_key, ent, isDir) {
        if (ent.name === config.NSFS_FOLDER_OBJECT_NAME) return dir_key;
        return dir_key + ent.name + (isDir ? '/' : '');
    }

    /**
     * @param {string} dir_key
     * @param {fs.Dirent} ent
     * @returns {string}
     */
     _get_version_entry_key(dir_key, ent) {
        if (ent.name === config.NSFS_FOLDER_OBJECT_NAME) return dir_key;
        return dir_key + HIDDEN_VERSIONS_PATH + '/' + ent.name;
    }

    async _make_path_dirs(file_path, fs_context) {
        const last_dir_pos = file_path.lastIndexOf('/');
        if (last_dir_pos > 0) return this._create_path(file_path.slice(0, last_dir_pos), fs_context);
    }

    /**
     * @returns {string}
     */
    _get_etag(stat) {
        const xattr_etag = this._etag_from_fs_xattr(stat.xattr);
        if (xattr_etag) return xattr_etag;
        // IMPORTANT NOTICE - we must return an etag that contains a dash!
        // because this is the criteria of S3 SDK to decide if etag represents md5
        // and perform md5 validation of the data.
        return this._get_version_id_by_stat(stat);
    }

    _is_gpfs(fs_context) {
        return Boolean(fs_context.backend === 'GPFS' && nb_native().fs.gpfs);
    }

    _etag_from_fs_xattr(xattr) {
        if (_.isEmpty(xattr)) return undefined;
        return xattr[XATTR_MD5_KEY];
    }

    /**
     * @param {string} bucket 
     * @param {string} key 
     * @param {nb.NativeFSStats} stat 
     * @returns {nb.ObjectInfo}
     */
     _get_object_info(bucket, key, stat, return_version_id, is_latest = true) {
        const etag = this._get_etag(stat);
        const create_time = stat.mtime.getTime();
        const encryption = this._get_encryption_info(stat);
        const version_id = return_version_id && this._is_versioning_enabled() && this._get_version_id_by_xattr(stat);
        const delete_marker = stat.xattr[XATTR_DELETE_MARKER] === 'true';
        const content_type = stat.xattr[XATTR_CONTENT_TYPE] || mime.getType(key) || 'application/octet-stream';

        return {
            obj_id: etag,
            bucket,
            key,
            size: stat.size,
            etag,
            create_time,
            content_type,
            encryption,
            version_id,
            is_latest,
            delete_marker,
            xattr: to_xattr(stat.xattr),

            // TODO ? storage_class: stat.xattr[XATTR_STORAGE_CLASS_KEY],

            // temp:
            tag_count: 0,
            lock_settings: undefined,
            md5_b64: undefined,
            num_parts: undefined,
            sha256_b64: undefined,
            stats: undefined,
            tagging: undefined,
        };
    }

    _get_upload_info(stat, version_id) {
        const etag = this._get_etag(stat);
        const encryption = this._get_encryption_info(stat);
        return {
            etag,
            encryption,
            version_id
        };
    }

    _get_encryption_info(stat) {
        // Currently encryption is supported only on top of GPFS, otherwise we will return undefined
        return stat.xattr['gpfs.Encryption'] ? {
            algorithm: 'AES256',
            kms_key_id: '',
            context_b64: '',
            key_md5_b64: '',
            key_b64: '',
        } : undefined;
    }

    // This function verifies the user didn't ask for SSE-S3 Encryption, when Encryption is not supported by the FS
    _verify_encryption(user_encryption, fs_encryption) {
        if (user_encryption && user_encryption.algorithm === 'AES256' && !fs_encryption) {
            dbg.error('upload_object: User requested encryption but encryption not supported for FS');
            throw new RpcError('SERVER_SIDE_ENCRYPTION_CONFIGURATION_NOT_FOUND_ERROR',
                'Encryption not supported by the FileSystem');
        }
    }

    _translate_object_error_codes(err) {
        if (err.rpc_code) return err;
        if (err.code === 'ENOENT') err.rpc_code = 'NO_SUCH_OBJECT';
        if (err.code === 'EEXIST') err.rpc_code = 'BUCKET_ALREADY_EXISTS';
        if (err.code === 'EPERM' || err.code === 'EACCES') err.rpc_code = 'UNAUTHORIZED';
        if (err.code === 'IO_STREAM_ITEM_TIMEOUT') err.rpc_code = 'IO_STREAM_ITEM_TIMEOUT';
        if (err.code === 'INTERNAL_ERROR') err.rpc_code = 'INTERNAL_ERROR';
        return err;
    }

    async _load_bucket(params, fs_context) {
        try {
            await nb_native().fs.stat(fs_context, this.bucket_path);
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }

    _mpu_path(params) {
        return path.join(
            this.bucket_path,
            this.get_bucket_tmpdir(),
            'multipart-uploads',
            params.obj_id
        );
    }

    async _load_multipart(params, fs_context) {
        await this._load_bucket(params, fs_context);
        params.mpu_path = this._mpu_path(params);
        try {
            await nb_native().fs.stat(fs_context, params.mpu_path);
        } catch (err) {
            // TOOD: Error handling
            if (err.code === 'ENOENT') err.rpc_code = 'NO_SUCH_UPLOAD';
            throw err;
        }
    }

    async _create_path(dir, fs_context) {
        let dir_path = path.isAbsolute(dir) ? path.sep : '';
        for (const item of dir.split(path.sep)) {
            dir_path = path.join(dir_path, item);
            try {
                await nb_native().fs.mkdir(fs_context, dir_path, get_umasked_mode(config.BASE_MODE_DIR));
            } catch (err) {
                const ERR_CODES = ['EISDIR', 'EEXIST'];
                if (!ERR_CODES.includes(err.code)) throw err;
            }
        }
        if (config.NSFS_TRIGGER_FSYNC) await nb_native().fs.fsync(fs_context, dir_path);
    }

    async _delete_path_dirs(file_path, fs_context) {
        try {
            let dir = path.dirname(file_path);
            while (dir !== this.bucket_path) {
                await nb_native().fs.rmdir(fs_context, dir);
                dir = path.dirname(dir);
            }
        } catch (err) {
            if (err.code !== 'ENOTEMPTY' &&
                err.code !== 'ENOENT' &&
                err.code !== 'ENOTDIR' &&
                err.code !== 'EACCES'
            ) {
                dbg.log0('NamespaceFS: _delete_object_empty_path skip on unexpected error', err);
            }
        }
    }

    async _folder_delete(dir, fs_context) {
        const entries = await nb_native().fs.readdir(fs_context, dir);
        const results = await Promise.all(entries.map(entry => {
            const fullPath = path.join(dir, entry.name);
            const task = isDirectory(entry) ? this._folder_delete(fullPath, fs_context) :
                nb_native().fs.unlink(fs_context, fullPath);
            return task.catch(error => ({ error }));
        }));
        results.forEach(result => {
            // Ignore missing files/directories; bail on other errors
            if (result && result.error && result.error.code !== 'ENOENT') throw result.error;
        });
        await nb_native().fs.rmdir(fs_context, dir);
    }

    async create_uls(params, object_sdk) {
        const fs_context = this.prepare_fs_context(object_sdk);
        dbg.log0('NamespaceFS: create_uls fs_context:', fs_context, 'new_dir_path: ', params.full_path);
        try {
            await nb_native().fs.mkdir(fs_context, params.full_path, get_umasked_mode(0o777));
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }

    async delete_uls(params, object_sdk) {
        const fs_context = this.prepare_fs_context(object_sdk);
        dbg.log0('NamespaceFS: delete_uls fs_context:', fs_context, 'to_delete_dir_path: ', params.full_path);

        try {
            const list = await this.list_objects({ ...params, limit: 1 }, object_sdk);

            if (list && list.objects && list.objects.length > 0) {
                throw new RpcError('NOT_EMPTY', 'underlying directory has files in it');
            }

            await this._folder_delete(params.full_path, fs_context);
        } catch (err) {
            throw this._translate_object_error_codes(err);
        }
    }

    async check_access(fs_context, dir_path) {
        try {
            dbg.log0('check_access: dir_path', dir_path, 'fs_context', fs_context);
            await this._check_path_in_bucket_boundaries(fs_context, dir_path);
            await nb_native().fs.checkAccess(fs_context, dir_path);
            return true;
        } catch (err) {
            dbg.error('check_access: error ', err.code, err, dir_path, this.bucket_path);
            const is_bucket_dir = dir_path === this.bucket_path;

            // if dir_path is the bucket path we would like to throw an error
            // for other dirs we will skip
            if (['EPERM', 'EACCES'].includes(err.code) && !is_bucket_dir) {
                return false;
            }
            if (err.code === 'ENOENT' && !is_bucket_dir) {
                // invalidate if dir
                dir_cache.invalidate({ dir_path, fs_context });
                return false;
            }
            throw err;
        }
    }

    /**
     * Return false if the entry is outside of the bucket
     * @param {*} fs_context
     * @param {*} entry_path
     * @returns
     */
    async _is_path_in_bucket_boundaries(fs_context, entry_path) {
        dbg.log1('check_bucket_boundaries: fs_context', fs_context, 'file_path', entry_path);
        if (!entry_path.startsWith(this.bucket_path)) {
            dbg.log0('check_bucket_boundaries: the path', entry_path, 'is not in the bucket', this.bucket_path, 'boundaries');
            return false;
        }
        try {
            // Returns the real path of the entry.
            // The entry path may point to regular file or directory, but can have symbolic links  
            const full_path = await nb_native().fs.realpath(fs_context, entry_path);
            if (!full_path.startsWith(this.bucket_path)) {
                dbg.log0('check_bucket_boundaries: the path', entry_path, 'is not in the bucket', this.bucket_path, 'boundaries');
                return false;
            }
        } catch (err) {
            // Error: No such file or directory
            // In the upload use case, the destination file desn't exist yet, need to validate the parent dirs path.
            if (err.code === 'ENOENT') {
                return this._is_path_in_bucket_boundaries(fs_context, path.dirname(entry_path));
            }
            // Read or search permission was denied for a component of the path prefix.
            if (err.code === 'EACCES') {
                return false;
            }
            throw error_utils.new_error_code('INTERNAL_ERROR',
                'check_bucket_boundaries error ' + err.code + ' ' + entry_path + ' ' + err, { cause: err });
        }
        return true;
    }

    /**
     * throws AccessDenied, if the entry is outside of the bucket
     * @param {*} fs_context
     * @param {*} entry_path
     */
    async _check_path_in_bucket_boundaries(fs_context, entry_path) {
        if (!config.NSFS_CHECK_BUCKET_BOUNDARIES) return;
        if (!(await this._is_path_in_bucket_boundaries(fs_context, entry_path))) {
            throw error_utils.new_error_code('EACCES', 'Entry ' + entry_path + ' is not in bucket boundaries');
        }
    }

    // TODO: without fsync this logic fails also for regular files because blocks take time to update after writing.
    // async _fail_if_archived_or_sparse_file(fs_context, file_path, stat) {
    //     if (isDirectory(stat)) return;
    //     // In order to verify if the file is stored in tape we compare sizes
    //     // Multiple number of blocks by default block size and verify we get the size of the object
    //     // If we get a size that is lower than the size of the object this means that it is taped or a spare file
    //     // We had to use this logic since we do not have a POSIX call in order to verify that the file is taped
    //     // This is why sparse files won't be accessible as well
    //     if (is_sparse_file(stat)) {
    //         dbg.log0(`_fail_if_archived_or_sparse_file: ${file_path} rejected`, stat);
    //         throw new RpcError('INVALID_OBJECT_STATE', 'Attempted to access archived or sparse file');
    //     }
    // }

    // when obj is a directory and size === 0 folder content (.folder) should not be created
    empty_dir_content_flow(file_path, params) {
        const is_dir_content = this._is_directory_content(file_path, params.key);
        return is_dir_content && params.size === 0;
    }

    //////////////////////////
    //// VERSIONING UTILS ////
    //////////////////////////

    _is_versioning_enabled() {
        return this.versioning === versioning_status_enum.VER_ENABLED;
    }

    _is_versioning_disabled() {
        return this.versioning === versioning_status_enum.VER_DISABLED;
    }

    _is_versioning_suspended() {
        return this.versioning === versioning_status_enum.VER_SUSPENDED;
    }

    _get_version_id_by_stat({ino, mtimeNsBigint}) {
        // TODO: GPFS might require generation number to be added to version_id
        return 'mtime-' + mtimeNsBigint.toString(36) + '-ino-' + ino.toString(36);
    }

    _get_version_id_by_mode(stat) {
        if (this._is_versioning_enabled()) return this._get_version_id_by_stat(stat);
        if (this._is_versioning_suspended()) return NULL_VERSION_ID;
        throw new Error('_get_version_id_by_mode: Invalid versioning mode');
    }

    // 1. if version_id_str is null version - nothing to extract
    // 2. else extract the mtime and ino or fail for invalid version_id_str
    // version_id_str - mtime-{mtimeNsBigint}-ino-{ino} | explicit null
    // returns mtimeNsBigint, ino (inode_number)
    _extract_version_info_from_xattr(version_id_str) {
        if (version_id_str === 'null') return;
        const arr = version_id_str.split('mtime-').join('').split('-ino-');
        if (arr.length < 2) throw new Error('Invalid version_id_string, cannot extract version info');
        return { mtimeNsBigint: size_utils.string_to_bigint(arr[0], 36), ino: parseInt(arr[1], 36) };
    }

    _get_version_id_by_xattr(stat) {
       return (stat && stat.xattr[XATTR_VERSION_ID]) || 'null';
    }

    // returns version path of the form bucket_path/dir/.versions/{key}_{version_id}
    _get_version_path(key, version_id) {
        const key_version = path.basename(key) + (version_id ? '_' + version_id : '');
        return path.normalize(path.join(this.bucket_path, path.dirname(key), HIDDEN_VERSIONS_PATH, key_version));
    }

    async _generate_unique_path(fs_context) {
        const rand_id = uuidv4();
        const unique_temp_path = path.join(this.bucket_path, this.get_bucket_tmpdir(), 'lost+found', rand_id);
        await this._make_path_dirs(unique_temp_path, fs_context);
        return unique_temp_path;
    }

    // this function returns the following version information -
    // version_id_str - mtime-{mtimeNsBigint}-ino-{ino} | explicit null
    // mtimeNsBigint - modified timestmap in bigint - last time the content of the file was modified
    // ino - refers to the data stored in a particular location
    // delete_marker - specifies if the version is a delete marker
    // prev_version_id - specifies the previous version of the wanted version
    // path - specifies the path to version
    // if version xattr contains version info - return info by xattr
    // else - it's a null version - return stat
    async _get_version_info(fs_context, version_path) {
        try {
            const stat = await nb_native().fs.stat(fs_context, version_path, { skip_user_xattr: true });
            dbg.log1('NamespaceFS._get_version_info stat ', stat, version_path);

            const version_id_str = this._get_version_id_by_xattr(stat);
            const ver_info_by_xattr = this._extract_version_info_from_xattr(version_id_str);
            return {
                ...(ver_info_by_xattr || stat),
                version_id_str,
                delete_marker: stat.xattr[XATTR_DELETE_MARKER],
                prev_version_id: stat.xattr[XATTR_PREV_VERSION_ID],
                path: version_path
            };
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            dbg.warn(`NamespaceFS._get_version_info version of ${version_path} doesn't exist`, err);
        }
        // if stat failed, undefined will return
    }

    // 1. if version exists in .versions/ folder - return its path
    // 2. else if version is latest version - return latest version path
    // 3. throw ENOENT error
    async _find_version_path(fs_context, { key, version_id }, return_md_path) {
        const cur_ver_path = return_md_path ? this._get_file_md_path({ key }) : this._get_file_path({ key });
        if (!version_id) return cur_ver_path;

        this._throw_if_wrong_version_format(version_id);
        const cur_ver_info = await this._get_version_info(fs_context, cur_ver_path);
        if (cur_ver_info && cur_ver_info.version_id_str === version_id) return cur_ver_path;

        const versioned_path = this._get_version_path(key, version_id);
        return versioned_path;
    }

    _throw_if_delete_marker(stat) {
        if (this.versioning === versioning_status_enum.VER_ENABLED || this.versioning === versioning_status_enum.VER_SUSPENDED) {
            const xattr_delete_marker = stat.xattr[XATTR_DELETE_MARKER];
            if (xattr_delete_marker) {
                throw error_utils.new_error_code('ENOENT', 'Entry is a delete marker');
            }
        }
    }

    _throw_if_wrong_version_format(version_id) {
        if (version_id === 'null') {
            return;
        }
        const v_parts = version_id.split('-');
        if (v_parts[0] !== 'mtime' || v_parts[2] !== 'ino') {
            throw new RpcError('BAD_REQUEST', 'Bad Request');
        }
        if (!version_format.test(v_parts[1]) || !version_format.test(v_parts[3])) {
            throw new RpcError('BAD_REQUEST', 'Bad Request');
        }
    }

    /**
     * @param {nb.NativeFSContext} fs_context 
     * @param {string} key 
     * @param {string} version_id 
     * @returns {Promise<{
     *   version_id_str: any;
     *   delete_marker: string;
     *   prev_version_id: string;
     *   path: any;
     *   mtimeNsBigint: bigint;
     *   ino: number;
     *   latest?: boolean;
     * }>}
     */
    // we can use this function when versioning is enabled or suspended
    async _delete_single_object_versioned(fs_context, key, version_id) {
        let retries = config.NSFS_RENAME_RETRIES;
        const is_gpfs = this._is_gpfs(fs_context);
        const latest_version_path = this._get_file_path({ key });
        for (;;) {
            let file_path;
            let gpfs_options;
            try {
                file_path = await this._find_version_path(fs_context, { key, version_id });
                await this._check_path_in_bucket_boundaries(fs_context, file_path);
                const version_info = await this._get_version_info(fs_context, file_path);
                if (!version_info) return;

                const deleted_latest = file_path === latest_version_path;
                if (deleted_latest) {
                    gpfs_options = is_gpfs ?
                        await this._open_files_gpfs(fs_context, file_path, undefined, undefined, undefined, undefined, true) :
                        undefined;
                    await this.safe_unlink(fs_context, file_path, version_info, gpfs_options);
                    return { ...version_info, latest: true };
                } else {
                    await nb_native().fs.unlink(fs_context, file_path);
                }
                return version_info;
            } catch (err) {
                retries -= 1;
                if (retries <= 0 || !this.should_retry_link_unlink(is_gpfs, err)) throw err;
                dbg.warn(`NamespaceFS._delete_single_object_versioned: retrying retries=${retries} file_path=${file_path}`, err);
            } finally {
                if (gpfs_options) await this._close_files_gpfs(fs_context, gpfs_options.delete_version, undefined, true);
            }
        }
    }

    // 1. iterate over the key's versions array
    //    1.1 if version_id is undefined, delete latest
    //    1.2 if version exists - unlink version
    // 2. try promote second latest to latest if one of the deleted versions is the latest version (with version id specified) or a delete marker
    async _delete_objects_versioned(fs_context, key, versions) {
        dbg.log1('NamespaceFS._delete_objects_versioned', key, versions);
        const res = [];
        let deleted_delete_marker;
        let delete_marker_created;
        let latest_ver_info;
        const latest_version_path = this._get_file_path({ key });
        await this._check_path_in_bucket_boundaries(fs_context, latest_version_path);
        for (const version_id of versions) {
            try {
                if (version_id) {
                    const del_ver_info = await this._delete_single_object_versioned(fs_context, key, version_id);
                    if (!del_ver_info) {
                        res.push({});
                        continue;
                    }
                    if (del_ver_info.latest) {
                        latest_ver_info = del_ver_info;
                    } else {
                        deleted_delete_marker = deleted_delete_marker || del_ver_info.delete_marker;
                    }
                    res.push({ deleted_delete_marker: del_ver_info.delete_marker });
                } else {
                    const version_res = await this._delete_latest_version(fs_context, latest_version_path, { key, version_id });
                    res.push(version_res);
                    delete_marker_created = true;
                }
            } catch (err) {
                res.push({ err_code: err.code, err_message: err.message });
            }
        }
        // we try promote only if the latest version was deleted or we deleted a delete marker
        // and no delete marker added (a new delete marker will be the latest - no need to promote)
        if ((latest_ver_info || deleted_delete_marker) && !delete_marker_created) {
            await this._promote_version_to_latest(fs_context, { key }, latest_ver_info, latest_version_path);
        }
        // delete .versions/ if it's empty
        const file_path = this._get_version_path(key);
        await this._delete_path_dirs(file_path, fs_context);
        return res;
    }

    // delete version_id -
    // 1. get version info, if it's empty - return
    // 2. unlink key
    // 3. if version is latest version - promote second latest -> latest
    async _delete_version_id(fs_context, file_path, params) {
        // TODO optimization - GPFS link overrides, no need to unlink before promoting, but if there is nothing to promote we should unlink
        const del_obj_version_info = await this._delete_single_object_versioned(fs_context, params.key, params.version_id);
        if (!del_obj_version_info) return {};

        // we try promote only if the latest version was deleted or we deleted a delete marker
        if (del_obj_version_info.latest || del_obj_version_info.delete_marker) {
            const latest_version_path = this._get_file_path({ key: params.key });
            await this._promote_version_to_latest(fs_context, params, del_obj_version_info, latest_version_path);
        }
        await this._delete_path_dirs(file_path, fs_context);
        return {
            deleted_delete_marker: del_obj_version_info.delete_marker,
            version_id: del_obj_version_info.version_id_str
        };
    }

    // 1. if deleted version is not latest version and not a delete marker - skip
    // 2. find max past version
    //    2.1. if max_past_version does not exist / is a delete marker - skip, nothing to move
    //    2.2. else - move max past version -> latest version path
    // 3. if deleted version mtime < max_past_version mtime - skip (check if deleted version is latest or latest delete marker in .versions/)
    // 4. move max past version -> latest version path
    // condition 2 guards on situations where we don't want to try move max version past to latest
    async _promote_version_to_latest(fs_context, params, deleted_version_info, latest_ver_path) {
        dbg.log1('Namespace_fs._promote_version_to_latest', params, deleted_version_info, latest_ver_path);
        const deleted_latest = deleted_version_info && deleted_version_info.path === latest_ver_path;
        const prev_version_id = deleted_latest && deleted_version_info.prev_version_id;

        let retries = config.NSFS_RENAME_RETRIES;
        for (;;) {
            try {
                const latest_version_info = await this._get_version_info(fs_context, latest_ver_path);
                if (latest_version_info) return;
                const max_past_ver_info = (prev_version_id &&
                    (await this.get_prev_version_info(fs_context, params.key, prev_version_id))) ||
                    (await this.find_max_version_past(fs_context, params.key));

                if (!max_past_ver_info || max_past_ver_info.delete_marker) return;
                // 2 - if deleted file is a delete marker and is older than max past version - no need to promote max - return
                if (deleted_version_info &&
                    deleted_version_info.delete_marker &&
                    deleted_version_info.mtimeNsBigint < max_past_ver_info.mtimeNsBigint) return;
                dbg.log1('Namespace_fs._promote_version_to_latest ', max_past_ver_info.path, latest_ver_path, max_past_ver_info, latest_version_info);
                // on concurrent put, safe_move_gpfs might override new coming latest (no fd verification, gpfs linkfileat will override)
                await this.safe_move_posix(fs_context, max_past_ver_info.path, latest_ver_path, max_past_ver_info);
                break;
            } catch (err) {
                retries -= 1;
                if (retries <= 0) throw err;
                if (!this._is_gpfs(fs_context) && err.code === 'EEXIST') {
                    dbg.warn('Namespace_fs._delete_version_id: latest version exist - skipping');
                    return;
                }
                if (err.code !== 'ENOENT') throw err;
                dbg.warn(`NamespaceFS: _promote_version_to_latest failed retries=${retries}`, err);
            }
        }
    }

    // delete latest version
    // 1. if latest version exists on the regular directory (not .versions/)
    //   1.2 if versioning is enabled OR
    //       versioning is suspended AND the latest version on the regular directory has a unique version id (not null)
    //     1.2.1 create .versions/ if it doesn't exist
    //     1.2.2 move latest version to .versions/
    //     1.2.3 if versioning is suspended AND the latest version on the regular directory has a unique version id (not null)
    //       1.2.3.1 remove latest version
    //    1.3. else (versioning is suspended AND the latest version on the regular directory is null)
    //      1.3.1 remove a version (or delete marker) with null version ID from .versions/ (if exists)
    // 2. else - latest version is a delete marker (inside .versions/) / doesn't exist - nothing to do
    //    * in case the latest version doesn't exist - we would still want to create the delete marker
    // 3. create delete marker and move it to .versions/key_{delete_marker_version_id}
    // retry safe linking a file in case of parallel put/delete of the source path
    async _delete_latest_version(fs_context, latest_ver_path, params) {
        dbg.log0('Namespace_fs._delete_latest_version:', latest_ver_path, params);

        let gpfs_options;
        const is_gpfs = this._is_gpfs(fs_context);
        let retries = config.NSFS_RENAME_RETRIES;
        let latest_ver_info;
        for (;;) {
            try {
                // get latest version_id if exists
                latest_ver_info = await this._get_version_info(fs_context, latest_ver_path);
                const versioned_path = latest_ver_info && this._get_version_path(params.key, latest_ver_info.version_id_str);
                const versioned_info = latest_ver_info && await this._get_version_info(fs_context, versioned_path);

                gpfs_options = is_gpfs ?
                    await this._open_files_gpfs(fs_context, latest_ver_path,
                        undefined, undefined, undefined, undefined, true, versioned_info) :
                    undefined;

                dbg.log1('Namespace_fs._delete_latest_version:', latest_ver_info, versioned_path, versioned_info, gpfs_options);
                if (latest_ver_info) {
                    const suspended_and_latest_is_not_null = this._is_versioning_suspended() &&
                        latest_ver_info.version_id_str !== NULL_VERSION_ID;
                    if (this._is_versioning_enabled() || suspended_and_latest_is_not_null) {
                         await this._make_path_dirs(versioned_path, fs_context);
                         await this.safe_move(fs_context, latest_ver_path, versioned_path, latest_ver_info,
                            gpfs_options && gpfs_options.delete_version);
                         if (suspended_and_latest_is_not_null) {
                            // remove a version (or delete marker) with null version ID from .versions/ (if exists)
                            await this._delete_null_version_from_versions_directory(params.key, fs_context);
                        }
                    } else {
                        // versioning suspended and version_id is null
                        dbg.log1('NamespaceFS._delete_latest_version: suspended mode version ID of the latest version is null - file will be unlinked');
                        await this.safe_unlink(fs_context, latest_ver_path, latest_ver_info, gpfs_options);
                    }
                }
                break;
            } catch (err) {
                retries -= 1;
                if (retries <= 0 || !this.should_retry_link_unlink(is_gpfs, err)) throw err;
                dbg.warn(`NamespaceFS._delete_latest_version: Retrying retries=${retries} latest_ver_path=${latest_ver_path}`, err);
            } finally {
                if (gpfs_options) await this._close_files_gpfs(fs_context, gpfs_options.delete_version, undefined, true);
            }
        }
        // create delete marker and move it to .versions/key_{delete_marker_version_id}
        const created_version_id = await this._create_delete_marker(fs_context, params, latest_ver_info);
        return {
            created_delete_marker: true,
            created_version_id
        };
    }

    // We can have only one versioned object with null version ID per key.
    // It can be latest version, old version in .version/ directory or delete marker
    // This function removes an object version or delete marker with a null version ID inside .version/ directory 
    async _delete_null_version_from_versions_directory(key, fs_context) {
        const is_gpfs = this._is_gpfs(fs_context);
        let retries = config.NSFS_RENAME_RETRIES;
        const null_versioned_path = this._get_version_path(key, NULL_VERSION_ID);
        await this._check_path_in_bucket_boundaries(fs_context, null_versioned_path);

        for (;;) {
            try {
                const null_versioned_path_info = await this._get_version_info(fs_context, null_versioned_path);
                dbg.log1('Namespace_fs._delete_null_version_from_versions_directory:', null_versioned_path, null_versioned_path_info);
                if (null_versioned_path_info) {
                    const gpfs_options = is_gpfs ?
                        await this._open_files_gpfs(fs_context, null_versioned_path, undefined, undefined, undefined, undefined, true) :
                        undefined;

                    await this.safe_unlink(fs_context, null_versioned_path, null_versioned_path_info, gpfs_options);

                    if (gpfs_options) await this._close_files_gpfs(fs_context, gpfs_options.delete_version, undefined, true);
                }
                break;
            } catch (err) {
                retries -= 1;
                if (retries <= 0 || !this.should_retry_link_unlink(is_gpfs, err)) throw err;
                dbg.warn(`NamespaceFS._delete_null_version_from_versions_directory Retrying retries=${retries} null_versioned_path=${null_versioned_path}`, err);
            }
        }
    }

    // TODO: support GPFS
    async _create_delete_marker(fs_context, params, deleted_version_info) {
        let retries = config.NSFS_RENAME_RETRIES;
        let upload_params;
        let delete_marker_version_id;
        for (;;) {
            try {
                upload_params = await this._start_upload(fs_context, undefined, undefined, params, 'w');

                const stat = await upload_params.target_file.stat(fs_context);
                if (this._is_versioning_enabled()) {
                    // the delete marker path built from its version info (mtime + ino)
                    delete_marker_version_id = this._get_version_id_by_stat(stat);
                } else {
                    // the delete marker file name would be with a 'null' suffix
                    delete_marker_version_id = NULL_VERSION_ID;
                }
                const file_path = this._get_version_path(params.key, delete_marker_version_id);

                let fs_xattr;
                if (this._is_versioning_suspended() &&
                    (deleted_version_info?.version_id_str === NULL_VERSION_ID)) {
                    fs_xattr = await this._assign_versions_to_fs_xattr(fs_context, undefined,
                        stat, params.key, undefined, true);
                } else {
                    // the previous version will be the deleted version
                    fs_xattr = await this._assign_versions_to_fs_xattr(fs_context, deleted_version_info,
                        stat, params.key, undefined, true);
                }
                if (fs_xattr) await upload_params.target_file.replacexattr(fs_context, fs_xattr);
                // create .version in case we don't have it yet
                await this._make_path_dirs(file_path, fs_context);
                await nb_native().fs.rename(fs_context, upload_params.upload_path, file_path);
                return delete_marker_version_id;
            } catch (err) {
                retries -= 1;
                if (retries <= 0) throw err;
                if (err.code === 'EEXIST') {
                    dbg.warn(`NamespaceFS: _create_delete_marker already exists, success`, err);
                    return delete_marker_version_id;
                }
                dbg.warn(`NamespaceFS: _create_delete_marker failed retries=${retries}`, err);
            } finally {
                if (upload_params) await this.complete_object_upload_finally(undefined, undefined, upload_params.target_file, fs_context);
            }
        }
    }

    async get_prev_version_info(fs_context, key, prev_version_id) {
        const prev_path = this._get_version_path(key, prev_version_id);
        const prev_path_info = await this._get_version_info(fs_context, prev_path);
        return prev_path_info;
    }

    // try find prev version by hint or by iterating on .versions/ dir
    async find_max_version_past(fs_context, key) {
        const versions_dir = path.normalize(path.join(this.bucket_path, path.dirname(key), HIDDEN_VERSIONS_PATH));
        try {
            const versions = await nb_native().fs.readdir(fs_context, versions_dir);
            const arr = await P.map_with_concurrency(10, versions, async entry => {
                const index = entry.name.endsWith('_null') ? entry.name.lastIndexOf('_null') : entry.name.lastIndexOf('_mtime-');
                // don't fail if version entry name is invalid, just keep searching
                if (index < 0 || entry.name.slice(0, index) !== key) return undefined;
                const { mtimeNsBigint } = this._extract_version_info_from_xattr(entry.name.slice(key.length + 1)) ||
                    (await this._get_version_info(fs_context, path.join(versions_dir, entry.name)));
                return { mtimeNsBigint, name: entry.name };
            });

            // find max past version by comparing the mtimeNsBigint val
            const max_entry_info = arr.reduce((acc, cur) => (cur && cur.mtimeNsBigint > acc.mtimeNsBigint ? cur : acc),
                                        { mtimeNsBigint: BigInt(0), name: undefined });
            return max_entry_info.mtimeNsBigint > BigInt(0) &&
                this._get_version_info(fs_context, path.join(versions_dir, max_entry_info.name));
        } catch (err) {
            dbg.warn('namespace_fs.find_max_version_past: .versions/ folder could not be found', err);
       }
    }

    _is_hidden_version_path(dir_key) {
        const idx = dir_key.indexOf(HIDDEN_VERSIONS_PATH);
        return ((idx === 0) || (idx > 0 && dir_key[idx - 1] === '/'));
    }

    ////////////////////////////
    /// MOVE & LINK & UNLINK ///
    ////////////////////////////

    async safe_move(fs_context, src_path, dst_path, src_ver_info, gpfs_options) {
        if (this._is_gpfs(fs_context)) {
            await this.safe_move_gpfs(fs_context, src_path, dst_path, gpfs_options);
        } else {
            await this.safe_move_posix(fs_context, src_path, dst_path, src_ver_info);
        }
    }

    async safe_unlink(fs_context, src_path, src_ver_info, gpfs_options) {
        if (this._is_gpfs(fs_context)) {
            const { src_file = undefined, dir_file = undefined } = gpfs_options;
            if (dir_file) {
                await this.safe_unlink_gpfs(fs_context, src_path, src_file, dir_file);
            } else {
                dbg.error(`safe_unlink: dir_file is ${dir_file}, cannot use it to call safe_unlink_gpfs`);
                throw new Error(`dir_file is ${dir_file}, need a value to safe unlink GPFS`);
            }
        } else {
            await this.safe_unlink_posix(fs_context, src_path, src_ver_info);
        }
    }

    // this function handles best effort of files move in posix file systems
    // 1. safe_link
    // 2. safe_unlink
    async safe_move_posix(fs_context, src_path, dst_path, src_ver_info) {
        dbg.log1('Namespace_fs.safe_move_posix', src_path, dst_path, src_ver_info);
        await this.safe_link_posix(fs_context, src_path, dst_path, src_ver_info);
        await this.safe_unlink_posix(fs_context, src_path, src_ver_info);
    }

    // safe_link_posix links src_path to dst_path while verifing dst_path has the expected ino and mtimeNsBigint values
    // src_file exists on uploads (open mode = 'w' ) or deletions
    // on uploads (open mode 'wt') the dir_file is used as the link source
    async safe_move_gpfs(fs_context, src_path, dst_path, gpfs_options) {
        const { src_file = undefined, dst_file = undefined, dir_file = undefined, should_unlink = false } = gpfs_options;
        dbg.log1('Namespace_fs.safe_move_gpfs', src_path, dst_path, dst_file, should_unlink);
        await this.safe_link_gpfs(fs_context, dst_path, src_file || dir_file, dst_file);
        if (should_unlink) await this.safe_unlink_gpfs(fs_context, src_path, src_file, dir_file);
    }

    // safe_link_posix links src_path to dst_path while verifing dst_path has the expected ino and mtimeNsBigint values
    async safe_link_posix(fs_context, src_path, dst_path, src_version_info) {
        dbg.log1('Namespace_fs.safe_link_posix:', src_path, dst_path, src_version_info);
        await nb_native().fs.safe_link(fs_context, src_path, dst_path, src_version_info.mtimeNsBigint, src_version_info.ino);
    }

    // 1. create unique temp path
    // 2. safe unlink path_to_delete while verifing the file to be deleted has the expected mtimeNsBigint and ino values
    async safe_unlink_posix(fs_context, to_delete_path, to_delete_version_info) {
        dbg.log1('Namespace_fs.safe_unlink_posix:', to_delete_path, to_delete_version_info);
        try {
            const unique_temp_path = await this._generate_unique_path(fs_context);
            const { mtimeNsBigint, ino } = to_delete_version_info;
            await nb_native().fs.safe_unlink(fs_context, to_delete_path, unique_temp_path, mtimeNsBigint, ino);
        } catch (err) {
            if (err.code === 'ENOENT') {
                dbg.warn('Namespace_fs.safe_unlink_posix unlink: file already deleted, ignoring..');
                return;
            }
            throw err;
        }
    }

    // safe_link_gpfs links source_path to dest_path while verifing dest.fd
    async safe_link_gpfs(fs_context, dst_path, src_file, dst_file) {
        dbg.log1('Namespace_fs.safe_link_gpfs source_file:', src_file, src_file.fd, dst_file, dst_file && dst_file.fd);
        await src_file.linkfileat(fs_context, dst_path, dst_file && dst_file.fd);
    }

    // safe_unlink_gpfs unlinks to_delete_path while verifing to_delete_path.fd
    async safe_unlink_gpfs(fs_context, to_delete_path, to_delete_file, dir_file) {
        dbg.log1('Namespace_fs._delete_version_id unlink:', dir_file, dir_file.fd, to_delete_path, to_delete_file, to_delete_file && to_delete_file.fd);
        try {
            await dir_file.unlinkfileat(fs_context, path.basename(to_delete_path), to_delete_file && to_delete_file.fd);
        } catch (err) {
            if (err.code === 'ENOENT') {
                dbg.warn('Namespace_fs.safe_unlink_gpfs unlink: file already deleted, ignoring..');
                return;
            }
            if (err.code === gpfs_link_unlink_retry_err) err.code = gpfs_unlink_retry_catch;
            throw err;
        }
    }

    should_retry_link_unlink(is_gpfs, err) {
        return is_gpfs ?
            [gpfs_link_unlink_retry_err, gpfs_unlink_retry_catch].includes(err.code) :
            [posix_link_retry_err, posix_unlink_retry_err].includes(err.message);
    }

    // opens the unopened files involved in the version move during upload/deletion
    // returns an object contains the relevant options for the move/unlink flow
    // eslint-disable-next-line max-params
    async _open_files_gpfs(fs_context, src_path, dst_path, upload_or_dir_file, dst_ver_info, open_mode, delete_version, versioned_info) {
        dbg.log1('Namespace_fs._open_files_gpfs:', src_path, src_path && path.dirname(src_path), dst_path, upload_or_dir_file, dst_ver_info, open_mode, delete_version, versioned_info);

        let src_file;
        let dst_file;
        let dir_file;
        let versioned_file;
        try {
            // open /versions/key_ver file if exists
            versioned_file = versioned_info && await this._open_file(fs_context, versioned_info.path, 'r');

            // open files for deletion flow
            if (delete_version) {
                src_file = await this._open_file(fs_context, src_path, 'r');
                dir_file = await this._open_file(fs_context, path.dirname(src_path), 'r');
                return { delete_version: { src_file, dir_file, dst_file: versioned_file, should_unlink: true } };
            }

            // open files for upload flow
            if (open_mode === 'wt') {
                dir_file = upload_or_dir_file;
            } else {
                src_file = upload_or_dir_file;
                dir_file = await this._open_file(fs_context, path.dirname(src_path), 'r');
            }
            if (dst_ver_info) {
                dbg.log1('NamespaceFS._open_files_gpfs dst version exist - opening dst version file...');
                dst_file = await this._open_file(fs_context, dst_path, 'r');
            }
            return {
                move_to_versions: { src_file: dst_file, dir_file, dst_file: versioned_file },
                move_to_dst: { src_file, dst_file, dir_file, versioned_file }
            };
        } catch (err) {
            dbg.error('NamespaceFS._open_files_gpfs couldn\'t open files', err);
            await this._close_files_gpfs(fs_context, { src_file, dst_file, dir_file, versioned_file }, open_mode, delete_version);
            throw err;
        }
    }

    // closes files opened during gpfs upload / deletion, avoiding closing files that opened sooner in the process
    async _close_files_gpfs(fs_context, files_to_close, open_mode, delete_version) {
        const { src_file, dst_file = undefined, dir_file, versioned_file = undefined } = files_to_close;
        try {
            if (src_file && (delete_version || open_mode === 'wt')) await src_file.close(fs_context);
        } catch (err) {
            dbg.warn('NamespaceFS: _close_files_gpfs src_file error', err);
        }
        try {
            if (dst_file) await dst_file.close(fs_context);
        } catch (err) {
            dbg.warn('NamespaceFS: _close_files_gpfs dst_file error', err);
        }
        try {
            if (dir_file && (delete_version || open_mode !== 'wt')) await dir_file.close(fs_context);
        } catch (err) {
            dbg.warn('NamespaceFS: _close_files_gpfs dir_file error', err);
        }
        try {
            if (versioned_file) await versioned_file.close(fs_context);
        } catch (err) {
            dbg.warn('NamespaceFS: _close_files_gpfs versioned_file error', err);
        }
    }

}

module.exports = NamespaceFS;
