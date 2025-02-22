/* Copyright (C) 2020 NooBaa */
/*eslint max-lines-per-function: ["error", 900]*/
'use strict';

const _ = require('lodash');
const fs = require('fs');
const util = require('util');
const path = require('path');
const mocha = require('mocha');
const crypto = require('crypto');
const assert = require('assert');

const P = require('../../util/promise');
const config = require('../../../config');
const fs_utils = require('../../util/fs_utils');
const s3_utils = require('../../endpoint/s3/s3_utils');
const nb_native = require('../../util/nb_native');
const NamespaceFS = require('../../sdk/namespace_fs');
const buffer_utils = require('../../util/buffer_utils');
const test_ns_list_objects = require('./test_ns_list_objects');
const endpoint_stats_collector = require('../../sdk/endpoint_stats_collector');

const inspect = (x, max_arr = 5) => util.inspect(x, { colors: true, depth: null, maxArrayLength: max_arr });

// TODO: In order to verify validity add content_md5_mtime as well
const XATTR_MD5_KEY = 'content_md5';
const XATTR_DIR_CONTENT = 'user.dir_content';

const MAC_PLATFORM = 'darwin';

const DEFAULT_FS_CONFIG = {
    uid: process.getuid(),
    gid: process.getgid(),
    backend: '',
    warn_threshold_ms: 100,
};

function make_dummy_object_sdk() {
    return {
        requesting_account: {
            force_md5_etag: false,
            nsfs_account_config: {
                uid: process.getuid(),
                gid: process.getgid(),
            }
        },
        abort_controller: new AbortController(),
        throw_if_aborted() {
            if (this.abort_controller.signal.aborted) throw new Error('request aborted signal');
        }
    };
}

mocha.describe('namespace_fs', function() {

    const src_bkt = 'src';
    const upload_bkt = 'test_ns_uploads_object';
    const mpu_bkt = 'test_ns_multipart_upload';

    const src_key = 'test/unit_tests/test_namespace_fs.js';
    let tmp_fs_path = '/tmp/test_namespace_fs';
    if (process.platform === MAC_PLATFORM) {
        tmp_fs_path = '/private/' + tmp_fs_path;
    }
    const dummy_object_sdk = make_dummy_object_sdk();
    const ns_src_bucket_path = `./${src_bkt}`;
    const ns_tmp_bucket_path = `${tmp_fs_path}/${src_bkt}`;

    const ns_src = new NamespaceFS({
        bucket_path: ns_src_bucket_path,
        bucket_id: '1',
        namespace_resource_id: undefined,
        access_mode: undefined,
        versioning: undefined,
        force_md5_etag: false,
        stats: endpoint_stats_collector.instance(),
    });
    const ns_tmp = new NamespaceFS({
        bucket_path: ns_tmp_bucket_path,
        bucket_id: '2',
        namespace_resource_id: undefined,
        access_mode: undefined,
        versioning: undefined,
        force_md5_etag: false,
        stats: endpoint_stats_collector.instance(),
    });

    mocha.before(async () => {
        await P.all(_.map([src_bkt, upload_bkt, mpu_bkt], async buck =>
            fs_utils.create_fresh_path(`${tmp_fs_path}/${buck}`)));
    });
    mocha.after(async () => {
        await P.all(_.map([src_bkt, upload_bkt, mpu_bkt], async buck =>
            fs_utils.folder_delete(`${tmp_fs_path}/${buck}`)));
    });
    mocha.after(async () => fs_utils.folder_delete(tmp_fs_path));

    mocha.describe('list_objects', function() {

        mocha.it('list src dir with delimiter', async function() {
            const res = await ns_src.list_objects({
                bucket: src_bkt,
                delimiter: '/',
            }, dummy_object_sdk);
            console.log(inspect(res, res.length));
            assert_sorted_list(res);
        });

        mocha.it('list src dir without delimiter', async function() {
            const res = await ns_src.list_objects({
                bucket: src_bkt,
            }, dummy_object_sdk);
            console.log(inspect(res, res.length));
            assert.deepStrictEqual(res.common_prefixes, []);
            assert_sorted_list(res);
        });

        mocha.it('list_object_versions', async function() {
            const res = await ns_src.list_object_versions({
                bucket: src_bkt,
                delimiter: '/',
            }, dummy_object_sdk);
            console.log(inspect(res, res.length));
            assert_sorted_list(res);
        });

        // include all the generic list tests
        test_ns_list_objects(ns_tmp, dummy_object_sdk, 'test_ns_list_objects');

        function assert_sorted_list(res) {
            let prev_key = '';
            for (const { key } of res.objects) {
                if (res.next_marker) {
                    assert(key <= res.next_marker, 'bad next_marker at key ' + key);
                }
                assert(prev_key <= key, 'objects not sorted at key ' + key);
                prev_key = key;
            }
            prev_key = '';
            for (const key of res.common_prefixes) {
                if (res.next_marker) {
                    assert(key <= res.next_marker, 'next_marker at key ' + key);
                }
                assert(prev_key <= key, 'prefixes not sorted at key ' + key);
                prev_key = key;
            }
        }
    });

    mocha.it('read_object_md', async function() {
        const res = await ns_src.read_object_md({
            bucket: src_bkt,
            key: src_key,
        }, dummy_object_sdk);
        console.log(inspect(res));
    });

    mocha.it('read_object_md succeed on directory head', async function() {
        const res = await ns_src.read_object_md({
            bucket: src_bkt,
            key: src_key.substr(0, src_key.lastIndexOf('/')),
        }, dummy_object_sdk);
        console.log(inspect(res));
    });

    mocha.describe('read_object_stream', function() {

        mocha.it('read full', async function() {
            const out = buffer_utils.write_stream();
            await ns_src.read_object_stream({
                bucket: src_bkt,
                key: src_key,
            }, dummy_object_sdk, out);
            const res = out.join().toString();
            assert.strict.equal(res.slice(13, 28), '(C) 2020 NooBaa');
            assert.strict.equal(res.slice(34, 40), 'eslint');
        });

        mocha.it('read range', async function() {
            const out = buffer_utils.write_stream();
            await ns_src.read_object_stream({
                bucket: src_bkt,
                key: src_key,
                start: 13,
                end: 28,
            }, dummy_object_sdk, out);
            const res = out.join().toString();
            assert.strict.equal(res, '(C) 2020 NooBaa');
        });

        mocha.it('read range above size', async function() {
            const too_high = 1000000000;
            const out = buffer_utils.write_stream();
            await ns_src.read_object_stream({
                bucket: src_bkt,
                key: src_key,
                start: too_high,
                end: too_high + 10,
            }, dummy_object_sdk, out);
            const res = out.join().toString();
            assert.strict.equal(res, '');
        });
    });

    mocha.describe('upload_object', function() {

        const upload_key = 'upload_key_1';
        const xattr = { key: 'value', key2: 'value2' };
        xattr[s3_utils.XATTR_SORT_SYMBOL] = true;

        mocha.it('upload, read, delete of a small object', async function() {
            const data = crypto.randomBytes(100);
            const upload_res = await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key,
                xattr,
                source_stream: buffer_utils.buffer_to_read_stream(data)
            }, dummy_object_sdk);
            console.log('upload_object response', inspect(upload_res));
            if (config.NSFS_CALCULATE_MD5 ||
                ns_tmp.force_md5_etag || dummy_object_sdk.requesting_account.force_md5_etag) xattr[XATTR_MD5_KEY] = upload_res.etag;

            const read_res = buffer_utils.write_stream();
            await ns_tmp.read_object_stream({
                bucket: upload_bkt,
                key: upload_key,
            }, dummy_object_sdk, read_res);
            console.log('read_object_stream response', inspect(read_res));
            const read_data = read_res.join();
            assert.strictEqual(Buffer.compare(read_data, data), 0);

            const md = await ns_tmp.read_object_md({
                bucket: upload_bkt,
                key: upload_key,
            }, dummy_object_sdk);
            console.log('read_object_md response', inspect(md));
            assert.deepStrictEqual(xattr, md.xattr);

            const delete_res = await ns_tmp.delete_object({
                bucket: upload_bkt,
                key: upload_key,
            }, dummy_object_sdk);
            console.log('delete_object response', inspect(delete_res));
        });
    });

    mocha.describe('multipart upload', function() {

        const mpu_key = 'mpu_upload';
        const xattr = { key: 'value', key2: 'value2' };
        xattr[s3_utils.XATTR_SORT_SYMBOL] = true;
        ns_tmp.force_md5_etag = true;
        ns_src.force_md5_etag = true;
        dummy_object_sdk.requesting_account.force_md5_etag = true;

        mocha.it('upload, read, delete a small multipart object', async function() {
            this.timeout(20000); // eslint-disable-line no-invalid-this

            const create_res = await ns_tmp.create_object_upload({
                bucket: mpu_bkt,
                key: mpu_key,
                xattr,
            }, dummy_object_sdk);
            console.log('create_object_upload response', inspect(create_res));

            const obj_id = create_res.obj_id;
            const num_parts = 10;
            const part_size = 1024 * 1024;
            const data = crypto.randomBytes(num_parts * part_size);
            const multiparts = [];
            for (let i = 0; i < num_parts; ++i) {
                const data_part = data.slice(i * part_size, (i + 1) * part_size);
                const part_res = await ns_tmp.upload_multipart({
                    obj_id,
                    bucket: mpu_bkt,
                    key: mpu_key,
                    num: i + 1,
                    source_stream: buffer_utils.buffer_to_read_stream(data_part),
                }, dummy_object_sdk);
                console.log('upload_multipart response', inspect(part_res));
                multiparts.push({ num: i + 1, etag: part_res.etag });

                const list_parts_res = await ns_tmp.list_multiparts({
                    obj_id,
                    bucket: mpu_bkt,
                    key: mpu_key,
                }, dummy_object_sdk);
                console.log('list_multiparts response', inspect(list_parts_res));
            }

            const list1_res = await ns_src.list_uploads({
                bucket: mpu_bkt,
            }, dummy_object_sdk);
            console.log('list_uploads response', inspect(list1_res));
            // TODO list_uploads is not implemented
            assert.deepStrictEqual(list1_res.objects, []);

            const complete_res = await ns_tmp.complete_object_upload({
                obj_id,
                bucket: mpu_bkt,
                key: mpu_key,
                multiparts,
            }, dummy_object_sdk);
            console.log('complete_object_upload response', inspect(complete_res));
            if (config.NSFS_CALCULATE_MD5 ||
                ns_tmp.force_md5_etag || dummy_object_sdk.requesting_account.force_md5_etag) xattr[XATTR_MD5_KEY] = complete_res.etag;

            const list2_res = await ns_src.list_uploads({
                bucket: mpu_bkt,
            }, dummy_object_sdk);
            console.log('list_uploads response', inspect(list2_res));
            assert.deepStrictEqual(list2_res.objects, []);

            const read_res = buffer_utils.write_stream();
            await ns_tmp.read_object_stream({
                bucket: mpu_bkt,
                key: mpu_key,
            }, dummy_object_sdk, read_res);
            console.log('read_object_stream response', inspect(read_res));
            const read_data = read_res.join();
            assert.strictEqual(Buffer.compare(read_data, data), 0);

            const md = await ns_tmp.read_object_md({
                bucket: upload_bkt,
                key: mpu_key,
            }, dummy_object_sdk);
            console.log('read_object_md response', inspect(md));
            assert.deepStrictEqual(xattr, md.xattr);

            const delete_res = await ns_tmp.delete_object({
                bucket: mpu_bkt,
                key: mpu_key,
            }, dummy_object_sdk);
            console.log('delete_object response', inspect(delete_res));
        });
    });

    mocha.describe('delete_object', function() {

        const dir_1 = '/a/b/c/';
        const dir_2 = '/a/b/';
        const upload_key_1 = dir_1 + 'upload_key_1';
        const upload_key_2 = dir_1 + 'upload_key_2';
        const upload_key_3 = dir_2 + 'upload_key_3';
        const data = crypto.randomBytes(100);

        mocha.before(async function() {
            const upload_res = await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key_1,
                source_stream: buffer_utils.buffer_to_read_stream(data)
            }, dummy_object_sdk);
            console.log('upload_object with path (before) response', inspect(upload_res));
        });

        mocha.it('do not delete the path', async function() {
            const source = buffer_utils.buffer_to_read_stream(data);
            await upload_object(ns_tmp, upload_bkt, upload_key_2, dummy_object_sdk, source);
            await delete_object(ns_tmp, upload_bkt, upload_key_2, dummy_object_sdk);

            let entries;
            try {
                entries = await nb_native().fs.readdir(DEFAULT_FS_CONFIG, ns_tmp_bucket_path + dir_1);
            } catch (e) {
                assert.ifError(e);
            }
            console.log('do not delete the path - entries', entries);
            assert.strictEqual(entries.length, 1);
        });


        mocha.it('delete the path - stop when not empty', async function() {
            const source = buffer_utils.buffer_to_read_stream(data);
            await upload_object(ns_tmp, upload_bkt, upload_key_3, dummy_object_sdk, source);
            await delete_object(ns_tmp, upload_bkt, upload_key_1, dummy_object_sdk);

            let entries;
            try {
                entries = await nb_native().fs.readdir(DEFAULT_FS_CONFIG, ns_tmp_bucket_path + dir_2);
            } catch (e) {
                assert.ifError(e);
            }
            console.log('stop when not empty - entries', entries);
            assert.strictEqual(entries.length, 1);

        });

        mocha.after(async function() {
            let entries_before;
            let entries_after;
            try {
                entries_before = await nb_native().fs.readdir(DEFAULT_FS_CONFIG, ns_tmp_bucket_path);

                const delete_res = await ns_tmp.delete_object({
                    bucket: upload_bkt,
                    key: upload_key_3,
                }, dummy_object_sdk);
                console.log('delete_object response', inspect(delete_res));

                entries_after = await nb_native().fs.readdir(DEFAULT_FS_CONFIG, ns_tmp_bucket_path);
            } catch (e) {
                assert.ifError(e);
            }
            assert.strictEqual(entries_after.length, entries_before.length - 1);
        });
    });

    mocha.describe('key with trailing /', function() {

        const dir_1 = '/a/b/c/';
        const dir_2 = '/a/b/';
        const upload_key_1 = dir_1 + 'upload_key_1/';
        const upload_key_2 = dir_2 + 'upload_key_2/';
        const data = crypto.randomBytes(100);

        mocha.before(async function() {
            const upload_res = await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key_1,
                source_stream: buffer_utils.buffer_to_read_stream(data)
            }, dummy_object_sdk);
            console.log('upload_object with trailing / response', inspect(upload_res));
        });

        mocha.it(`delete the path - stop when not empty and key with trailing /`, async function() {
            const upload_res = await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key_2,
                source_stream: buffer_utils.buffer_to_read_stream(data)
            }, dummy_object_sdk);
            console.log('upload_object with trailing / (key 2) response', inspect(upload_res));

            const delete_res = await ns_tmp.delete_object({
                bucket: upload_bkt,
                key: upload_key_1,
            }, dummy_object_sdk);
            console.log('delete_object with trailing / response', inspect(delete_res));
        });

        mocha.after(async function() {
            const delete_res = await ns_tmp.delete_object({
                bucket: upload_bkt,
                key: upload_key_2,
            }, dummy_object_sdk);
            console.log('delete_object with trailing / (key 2) response', inspect(delete_res));
        });
    });

});



mocha.describe('namespace_fs folders tests', function() {
    const src_bkt = 'src';
    const upload_bkt = 'test_ns_uploads_object';
    const mpu_bkt = 'test_ns_multipart_upload';
    const md = { key1: 'val1', key2: 'val2' };
    const md1 = { key123: 'val123', key234: 'val234' };
    const user_md = _.mapKeys(md, (val, key) => 'user.' + key);
    const user_md1 = _.mapKeys(md1, (val, key) => 'user.' + key);
    const dir_content_md = { [XATTR_DIR_CONTENT]: 'true' };
    const user_md_and_dir_content_xattr = { ...user_md, ...dir_content_md };
    const user_md1_and_dir_content_xattr = { ...user_md1, ...dir_content_md };
    let not_user_xattr = {};
    let tmp_fs_path = '/tmp/test_namespace_fs';
    if (process.platform === MAC_PLATFORM) {
        tmp_fs_path = '/private' + tmp_fs_path;
        not_user_xattr = { 'not_user_xattr1': 'not1', 'not_user_xattr2': 'not2' };
    }
    const dummy_object_sdk = make_dummy_object_sdk();
    const ns_tmp_bucket_path = `${tmp_fs_path}/${src_bkt}`;
    const ns_tmp = new NamespaceFS({ bucket_path: ns_tmp_bucket_path, bucket_id: '2', namespace_resource_id: undefined });

    mocha.before(async () => {
        await P.all(_.map([src_bkt, upload_bkt, mpu_bkt], async buck =>
            fs_utils.create_fresh_path(`${tmp_fs_path}/${buck}`)));
    });
    mocha.after(async () => {
        await P.all(_.map([src_bkt, upload_bkt, mpu_bkt], async buck =>
            fs_utils.folder_delete(`${tmp_fs_path}/${buck}`)));
    });
    mocha.after(async () => fs_utils.folder_delete(tmp_fs_path));

    mocha.describe('folders xattr', function() {
        const dir_1 = 'a/b/c/';
        const upload_key_1 = dir_1 + 'upload_key_1/';
        const upload_key_2 = 'my_dir/';
        //const upload_key_2_copy = 'my_copy_dir/';
        const upload_key_3 = 'my_dir_0_content/';
        const upload_key_4 = 'my_dir2/';
        const upload_key_5 = 'my_dir_mpu1/';
        const upload_key_6 = 'my_dir_mpu2/';
        const upload_key_4_full = path.join(upload_key_2, upload_key_4);
        const obj_sizes_map = {
            [upload_key_1]: 100,
            [upload_key_2]: 100,
            [upload_key_3]: 0,
            [upload_key_4_full]: 100
        };
        const mpu_keys_and_size_map = {
            [upload_key_5]: 100,
            [upload_key_6]: 0
        };
        const a = 'a/';
        const data = crypto.randomBytes(100);

        mocha.before(async function() {
            const stream1 = buffer_utils.buffer_to_read_stream(data);
            await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key_1,
                xattr: md,
                source_stream: stream1,
                size: obj_sizes_map[upload_key_1]
            }, dummy_object_sdk);
            const full_xattr = await get_xattr(ns_tmp_bucket_path + '/' + upload_key_1);
            assert.equal(Object.keys(full_xattr).length, 3);
            assert.deepEqual(full_xattr, {
                ...user_md_and_dir_content_xattr,
                [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_1]
            });

            // a/ should not have dir_content xattr since it's not an object
            const full_xattr1 = await get_xattr(ns_tmp_bucket_path + '/a/');
            assert.equal(Object.keys(full_xattr1).length, 0);
            assert.deepEqual(full_xattr1, {});
            await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key_2,
                xattr: md,
                source_stream: buffer_utils.buffer_to_read_stream(data),
                size: obj_sizes_map[upload_key_2]
            }, dummy_object_sdk);
            const full_xattr2 = await get_xattr(ns_tmp_bucket_path + '/' + upload_key_2);
            assert.equal(Object.keys(full_xattr2).length, 3);
            assert.deepEqual(full_xattr2, {
                ...user_md_and_dir_content_xattr,
                [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_2]
            });

            await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key_3,
                xattr: md,
                source_stream: buffer_utils.buffer_to_read_stream(undefined),
                size: obj_sizes_map[upload_key_3]
            }, dummy_object_sdk);
            const full_xattr3 = await get_xattr(ns_tmp_bucket_path + '/' + upload_key_3);
            assert.equal(Object.keys(full_xattr3).length, 3);
            assert.deepEqual(full_xattr3, {
                ...user_md_and_dir_content_xattr,
                [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_3]
            });

            await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key_4_full,
                xattr: md,
                source_stream: buffer_utils.buffer_to_read_stream(data),
                size: obj_sizes_map[upload_key_4_full]
            }, dummy_object_sdk);
            const full_xattr4 = await get_xattr(ns_tmp_bucket_path + '/' + upload_key_4_full);
            assert.equal(Object.keys(full_xattr4).length, 3);
            assert.deepEqual(full_xattr4, {
                ...user_md_and_dir_content_xattr,
                [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_4_full]
            });
            await P.all(Object.keys(mpu_keys_and_size_map).map(async key => {
                const mpu_upload_id1 = await ns_tmp.create_object_upload({
                    bucket: upload_bkt,
                    key: key,
                    xattr: mpu_keys_and_size_map[key] > 0 ? md : undefined,
                }, dummy_object_sdk);

                const put_part_res = await ns_tmp.upload_multipart({
                    bucket: upload_bkt,
                    key: key,
                    num: 1,
                    source_stream: buffer_utils.buffer_to_read_stream(mpu_keys_and_size_map[key] > 0 ? data : undefined),
                    size: mpu_keys_and_size_map[key],
                    obj_id: mpu_upload_id1.obj_id
                }, dummy_object_sdk);

                await ns_tmp.complete_object_upload({
                    bucket: upload_bkt,
                    key: key,
                    obj_id: mpu_upload_id1.obj_id,
                    multiparts: [{ num: 1, etag: put_part_res.etag }]
                }, dummy_object_sdk);
                const p = path.join(ns_tmp_bucket_path, key);
                const p1 = path.join(ns_tmp_bucket_path, key, config.NSFS_FOLDER_OBJECT_NAME);

                const full_xattr_mpu = await get_xattr(p);
                if (mpu_keys_and_size_map[key] > 0) {
                    assert.equal(Object.keys(full_xattr_mpu).length, 3);
                    assert.deepEqual(full_xattr_mpu, { ...user_md_and_dir_content_xattr, [XATTR_DIR_CONTENT]: mpu_keys_and_size_map[key] });
                    await fs_utils.file_must_exist(p1);
                } else {
                    assert.equal(Object.keys(full_xattr_mpu).length, 1);
                    assert.deepEqual(full_xattr_mpu, { ...dir_content_md, [XATTR_DIR_CONTENT]: mpu_keys_and_size_map[key] });
                    await fs_utils.file_must_exist(p1); // On mpu we always create DIR_CONTENT_FILE, even if its size is 0
                }
            }));
        });

        mocha.it(`read folder object md full md`, async function() {
            const get_md_res = await ns_tmp.read_object_md({
                bucket: upload_bkt,
                key: upload_key_1,
            }, dummy_object_sdk);
            assert.equal(Object.keys(get_md_res.xattr).length, 2);
            assert.deepEqual(get_md_res.xattr, md);
            const full_xattr = await get_xattr(ns_tmp_bucket_path + '/' + upload_key_1);
            assert.equal(Object.keys(full_xattr).length, 3);
            assert.deepEqual(full_xattr, {
                ...user_md_and_dir_content_xattr,
                [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_1]
            });
        });
        // check copy works for dirs on master
        // mocha.it(`copy object & read folder object md full md`, async function() {
        //     const upload_res2 = await ns_tmp.upload_object({
        //         bucket: upload_bkt,
        //         key: upload_key_2_copy,
        //         copy_source: { key: upload_key_2 }
        //     }, dummy_object_sdk);
        //     console.log('copy object with trailing / response', inspect(upload_res2));

        //     const get_md_res = await ns_tmp.read_object_md({
        //         bucket: upload_bkt,
        //         key: upload_key_2_copy,
        //     }, dummy_object_sdk);
        //     console.log('copy object read folder object md ', inspect(get_md_res));

        //     const full_xattr2 = await get_xattr(DEFAULT_FS_CONFIG, path.join(ns_tmp_bucket_path, upload_key_2_copy));
        //     console.log('copy object full xattr ', inspect(full_xattr2));
        //     assert.equal(Object.keys(full_xattr2).length, 3);
        //     assert.deepEqual(full_xattr2, user_md_and_dir_content_xattr);

        //     const p = path.join(ns_tmp_bucket_path, upload_key_2_copy, config.NSFS_FOLDER_OBJECT_NAME);
        //     await fs_utils.file_must_exist(p);
        // });

        mocha.it(`override object & read folder object md full md`, async function() {
            const read_res = buffer_utils.write_stream();
            await ns_tmp.read_object_stream({
                bucket: upload_bkt,
                key: upload_key_2,
            }, dummy_object_sdk, read_res);
            assert.equal(read_res.buffers.length, 1);
            assert.equal(read_res.total_length, 100);

            if (Object.keys(not_user_xattr).length) await set_xattr(DEFAULT_FS_CONFIG, ns_tmp_bucket_path + '/' + upload_key_2, not_user_xattr);

            const new_size = 0;
            await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key_2,
                xattr: md1,
                source_stream: buffer_utils.buffer_to_read_stream(data),
                size: new_size
            }, dummy_object_sdk);

            const get_md_res = await ns_tmp.read_object_md({
                bucket: upload_bkt,
                key: upload_key_2,
            }, dummy_object_sdk);
            assert.ok(Object.keys(md1).every(md_cur => get_md_res.xattr[md_cur] !== undefined));
            const full_xattr2 = await get_xattr(ns_tmp_bucket_path + '/' + upload_key_2);
            assert.deepEqual(full_xattr2, { ...user_md1_and_dir_content_xattr, [XATTR_DIR_CONTENT]: new_size, ...not_user_xattr });


            const read_res1 = buffer_utils.write_stream();
            await ns_tmp.read_object_stream({
                bucket: upload_bkt,
                key: upload_key_2,
            }, dummy_object_sdk, read_res1);
            assert.equal(read_res1.buffers.length, 0);
            assert.equal(read_res1.total_length, 0);
        });

        mocha.it(`read folder object md full md`, async function() {
            const get_md_res = await ns_tmp.read_object_md({
                bucket: upload_bkt,
                key: upload_key_3,
            }, dummy_object_sdk);
            assert.equal(Object.keys(get_md_res.xattr).length, 2);
            assert.deepEqual(get_md_res.xattr, md);
            const full_xattr = await get_xattr(ns_tmp_bucket_path + '/' + upload_key_3);
            assert.equal(Object.keys(full_xattr).length, 3);
            assert.deepEqual(full_xattr, { ...user_md_and_dir_content_xattr, [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_3] });

        });

        mocha.it(`.folder of dir object of content of size > 0 - should exist`, async function() {
            const p = path.join(ns_tmp_bucket_path, upload_key_1, config.NSFS_FOLDER_OBJECT_NAME);
            await fs_utils.file_must_exist(p);
        });

        mocha.it(`read folder object - 0 content - should return empty file`, async function() {
            const read_res = buffer_utils.write_stream();
            await ns_tmp.read_object_stream({
                bucket: upload_bkt,
                key: upload_key_3,
            }, dummy_object_sdk, read_res);
            assert.equal(read_res.buffers.length, 0);
            assert.equal(read_res.total_length, 0);
        });

        mocha.it(`.folder of dir object of content of size 0 - should not exist`, async function() {
            const p = path.join(ns_tmp_bucket_path, upload_key_3, config.NSFS_FOLDER_OBJECT_NAME);
            await fs_utils.file_must_not_exist(p);
        });


        mocha.it(`read folder object > 0 content - should return data`, async function() {
            const read_res = buffer_utils.write_stream();
            await ns_tmp.read_object_stream({
                bucket: upload_bkt,
                key: upload_key_1,
            }, dummy_object_sdk, read_res);
            assert.equal(read_res.buffers.length, 1);
            assert.equal(read_res.total_length, 100);
        });

        mocha.it(`.folder of non directory object - should not exist`, async function() {
            const p = path.join(ns_tmp_bucket_path, a, config.NSFS_FOLDER_OBJECT_NAME);
            await fs_utils.file_must_not_exist(p);
        });

        mocha.it(`read folder object md missing md`, async function() {
            const dir_path = ns_tmp_bucket_path + '/' + dir_1;
            const get_md_res = await ns_tmp.read_object_md({
                bucket: upload_bkt,
                key: dir_1,
            }, dummy_object_sdk);
            assert.equal(Object.keys(get_md_res.xattr).length, 0);
            const full_xattr = await get_xattr(dir_path);
            assert.equal(Object.keys(full_xattr).length, 0);
        });

        mocha.it(`put /a/b/c folder object md exists`, async function() {
            const dir_path = ns_tmp_bucket_path + '/' + dir_1;
            await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: dir_1,
                source_stream: buffer_utils.buffer_to_read_stream(data),
                size: 0
            }, dummy_object_sdk);
            const full_xattr2 = await get_xattr(dir_path);
            assert.equal(Object.keys(full_xattr2).length, 1);
            assert.ok(full_xattr2[XATTR_DIR_CONTENT] !== undefined && full_xattr2[XATTR_DIR_CONTENT] === '0');

            const get_md_res = await ns_tmp.read_object_md({
                bucket: upload_bkt,
                key: dir_1,
            }, dummy_object_sdk);
            assert.equal(Object.keys(get_md_res.xattr).length, 0);
            await fs_utils.file_must_not_exist(path.join(dir_path, config.NSFS_FOLDER_OBJECT_NAME));

        });

        mocha.it(`list objects md with delimiter`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({
                bucket: upload_bkt,
                delimiter: '/',
            }, dummy_object_sdk);
            assert.deepEqual(ls_obj_res.common_prefixes, [a, upload_key_2, upload_key_3, upload_key_5, upload_key_6]);
        });

        mocha.it(`list objects md with delimiter & prefix`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({
                bucket: upload_bkt,
                delimiter: '/',
                prefix: upload_key_2
            }, dummy_object_sdk);
            assert.deepEqual(ls_obj_res.common_prefixes, [upload_key_2 + upload_key_4]);
            assert.deepEqual(ls_obj_res.objects.map(obj => obj.key), [upload_key_2]);

        });

        mocha.it(`list objects md`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({ bucket: upload_bkt, }, dummy_object_sdk);
            console.log('list objects md 1 ', inspect(ls_obj_res));
            assert.deepEqual(ls_obj_res.common_prefixes, []);
            assert.deepEqual(ls_obj_res.objects.map(obj => obj.key),
                [dir_1, upload_key_1, upload_key_2, upload_key_4_full, upload_key_3, upload_key_5, upload_key_6]);
        });

        mocha.it(`list objects md key marker 1 - dir content`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({ bucket: upload_bkt, key_marker: dir_1 }, dummy_object_sdk);
            console.log('list objects md key marker 1', inspect(ls_obj_res));
            assert.deepEqual(ls_obj_res.objects.map(obj => obj.key),
                [upload_key_1, upload_key_2, upload_key_4_full, upload_key_3, upload_key_5, upload_key_6]);
            assert.deepEqual(ls_obj_res.common_prefixes, []);
        });

        mocha.it(`list objects md key marker 2`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({ bucket: upload_bkt, key_marker: 'a/b/c' }, dummy_object_sdk);
            console.log('list objects md key marker 2', inspect(ls_obj_res));
            assert.deepEqual(ls_obj_res.objects.map(obj => obj.key),
                [dir_1, upload_key_1, upload_key_2, upload_key_4_full, upload_key_3, upload_key_5, upload_key_6]);
            assert.deepEqual(ls_obj_res.common_prefixes, []);
        });

        mocha.it(`list objects md prefix 1`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({ bucket: upload_bkt, prefix: dir_1, delimiter: '/' }, dummy_object_sdk);
            console.log('list objects md prefix 1', inspect(ls_obj_res));
            assert.deepEqual(ls_obj_res.objects.map(obj => obj.key), [dir_1]);
            assert.deepEqual(ls_obj_res.common_prefixes, [upload_key_1]);
        });

        mocha.it(`list objects md prefix 2`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({ bucket: upload_bkt, prefix: 'a/b/c', delimiter: '/' }, dummy_object_sdk);
            console.log('list objects md prefix 2', inspect(ls_obj_res));
            assert.deepEqual(ls_obj_res.objects.map(obj => obj.key), []);
            assert.deepEqual(ls_obj_res.common_prefixes, [dir_1]);
        });

        mocha.it(`list objects md prefix 3 - not an object`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({ bucket: upload_bkt, prefix: 'a/b/', delimiter: '/' }, dummy_object_sdk);
            console.log('list objects md prefix 3', inspect(ls_obj_res));
            assert.deepEqual(ls_obj_res.objects.map(obj => obj.key), []);
            assert.deepEqual(ls_obj_res.common_prefixes, [dir_1]);
        });

        mocha.it(`list objects md prefix 4`, async function() {
            const ls_obj_res = await ns_tmp.list_objects({ bucket: upload_bkt, prefix: 'a/b', delimiter: '/' }, dummy_object_sdk);
            console.log('list objects md prefix 4', inspect(ls_obj_res));
            assert.deepEqual(ls_obj_res.objects.map(obj => obj.key), []);
            assert.deepEqual(ls_obj_res.common_prefixes, ['a/b/']);
        });

        mocha.it('delete inner directory object /my-dir when exists /my-dir/my-dir2', async function() {
            await ns_tmp.delete_object({
                bucket: upload_bkt,
                key: upload_key_2,
            }, dummy_object_sdk);

            const p1 = path.join(ns_tmp_bucket_path, upload_key_2);
            await fs_utils.file_must_not_exist(path.join(p1, config.NSFS_FOLDER_OBJECT_NAME));
            const p2 = path.join(ns_tmp_bucket_path, upload_key_2, upload_key_4);
            await fs_utils.file_must_exist(path.join(p2, config.NSFS_FOLDER_OBJECT_NAME));

            const full_xattr1 = await get_xattr(p1);
            assert.deepEqual(full_xattr1, { ...not_user_xattr });

            const full_xattr2 = await get_xattr(p2);
            assert.deepEqual(full_xattr2, { ...user_md_and_dir_content_xattr, [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_2] });

        });

        mocha.it('delete object content 0 - no .folder file', async function() {
            const p1 = path.join(ns_tmp_bucket_path, upload_key_3);
            const full_xattr1 = await get_xattr(p1);
            assert.deepEqual(full_xattr1, { ...user_md_and_dir_content_xattr, [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_3] });
            await ns_tmp.delete_object({ bucket: upload_bkt, key: upload_key_3, }, dummy_object_sdk);
            await fs_utils.file_must_not_exist(path.join(p1, config.NSFS_FOLDER_OBJECT_NAME));
            await fs_utils.file_must_not_exist(p1);
        });

        mocha.it('delete multiple objects /my-dir/my-dir2', async function() {
            const p1 = path.join(ns_tmp_bucket_path, upload_key_2);
            const p2 = path.join(p1, upload_key_4);
            const full_xattr1 = await get_xattr(p2);
            assert.deepEqual(full_xattr1, { ...user_md_and_dir_content_xattr, [XATTR_DIR_CONTENT]: obj_sizes_map[upload_key_4_full] });
            await ns_tmp.delete_multiple_objects({
                bucket: upload_bkt,
                objects: [upload_key_2 + upload_key_4, upload_key_2].map(key => ({ key })),
            }, dummy_object_sdk);
            await fs_utils.file_must_not_exist(path.join(p2, config.NSFS_FOLDER_OBJECT_NAME));
            await fs_utils.file_must_not_exist(p2);
            await fs_utils.file_must_not_exist(p1);

        });
        mocha.it('delete multiple objects - a/b/c/', async function() {
            const p1 = path.join(ns_tmp_bucket_path, dir_1);
            await ns_tmp.delete_multiple_objects({
                bucket: upload_bkt,
                objects: [dir_1].map(key => ({ key })),
            }, dummy_object_sdk);
            await fs_utils.file_must_exist(p1);
            await fs_utils.file_must_not_exist(path.join(p1, config.NSFS_FOLDER_OBJECT_NAME));
            const full_xattr1 = await get_xattr(p1);
            assert.deepEqual(full_xattr1, {});
        });
    });
});

// need to check how it behaves on master
// mocha.it('delete object', async function() {
//     const delete_res = await ns_tmp.delete_object({
//         bucket: upload_bkt,
//         key: 'my_dir',
//     }, dummy_object_sdk);
//     console.log('delete_object with trailing / (key 2) response', inspect(delete_res));
// });

async function get_xattr(file_path) {
    const stat = await nb_native().fs.stat(DEFAULT_FS_CONFIG, file_path);
    return stat.xattr;
}

async function set_xattr(fs_account_config, file_path, fs_xattr) {
    let file;
    try {
        file = await nb_native().fs.open(fs_account_config, file_path, undefined, get_umasked_mode(config.BASE_MODE_FILE));
        const full_xattr = await file.replacexattr(DEFAULT_FS_CONFIG, fs_xattr);
        return full_xattr;
    } catch (err) {
        console.log('ERROR: test_namespace_fs set_xattr', err);
        throw err;
    } finally {
        file.close(DEFAULT_FS_CONFIG, file_path);
    }
}


function get_umasked_mode(mode) {
    // eslint-disable-next-line no-bitwise
    return mode & ~config.NSFS_UMASK;
}
mocha.describe('nsfs_symlinks_validations', function() {

    let tmp_fs_path = '/tmp/test_nsfs_symboliclinks';
    if (process.platform === MAC_PLATFORM) {
        tmp_fs_path = '/private/' + tmp_fs_path;
    }
    const bucket = 'bucket1';
    const bucket_full_path = tmp_fs_path + '/' + bucket;
    const expected_dirs = ['d1', 'd2', 'd3/d3d1'];
    const expected_files = ['f1', 'f2', 'f3', 'd2/f4', 'd2/f5', 'd3/d3d1/f6'];
    const expected_links = [{ t: 'f1', n: 'lf1' }, { t: '/etc', n: 'ld2' }];
    const dummy_object_sdk = make_dummy_object_sdk();

    const ns = new NamespaceFS({ bucket_path: bucket_full_path, bucket_id: '1', namespace_resource_id: undefined });

    mocha.before(async () => {
        await fs_utils.create_fresh_path(`${bucket_full_path}`);
        await P.all(_.map(expected_dirs, async dir =>
            fs_utils.create_fresh_path(`${bucket_full_path}/${dir}`)));
        await P.all(_.map(expected_files, async file =>
            create_file(`${bucket_full_path}/${file}`)));
        await P.all(_.map(expected_links, async link =>
            fs.promises.symlink(link.t, `${bucket_full_path}/${link.n}`)));

    });

    mocha.after(async () => {
        await P.all(_.map(expected_files, async file =>
            fs_utils.folder_delete(`${bucket_full_path}/${file}`)));
    });
    mocha.after(async () => fs_utils.folder_delete(tmp_fs_path));

    mocha.describe('without_symlinks', function() {
        mocha.it('without_symlinks:list iner dir', async function() {
            const res = await list_objects(ns, bucket, '/', 'd2/', dummy_object_sdk);
            assert.strictEqual(res.objects.length, 2, 'amount of files is not as expected');
        });

        mocha.it('without_symlinks:list iner dir without delimiter', async function() {
            const res = await list_objects(ns, bucket, undefined, 'd2/', dummy_object_sdk);
            assert.strictEqual(res.objects.length, 2, 'amount of files is not as expected');
        });

        mocha.it('without_symlinks:read_object_md', async function() {
            try {
                await read_object_md(ns, bucket, 'd2/f4', dummy_object_sdk);
            } catch (err) {
                assert(err, 'read_object_md failed with err');
            }
        });

        mocha.it('without_symlinks:read_object_stream', async function() {
            try {
                await read_object_stream(ns, bucket, 'd2/f4', dummy_object_sdk);
            } catch (err) {
                assert(err, 'read_object_stream failed with err');
            }
        });

        mocha.it('without_symlinks:upload_object', async function() {
            const data = crypto.randomBytes(100);
            const source = buffer_utils.buffer_to_read_stream(data);
            try {
                await upload_object(ns, bucket, 'd2/uploaded-file1', dummy_object_sdk, source);
            } catch (err) {
                assert(err, 'upload_object failed with err');
            }
        });

        mocha.it('without_symlinks:delete_object', async function() {
            try {
                await delete_object(ns, bucket, 'd2/uploaded-file1', dummy_object_sdk);
            } catch (err) {
                assert(err, 'delete_object failed with err');
            }
        });
    });

    mocha.describe('by_symlinks', function() {
        mocha.it('by_symlinks:list root dir', async function() {
            const res = await list_objects(ns, bucket, '/', undefined, dummy_object_sdk);
            assert.strictEqual(res.objects.length, 4, 'amount of files is not as expected');
        });

        mocha.it('by_symlinks:list src dir without delimiter', async function() {
            const res = await list_objects(ns, bucket, undefined, undefined, dummy_object_sdk);
            console.log("IGOR", res.objects);
            assert.strictEqual(res.objects.length, 7, 'amount of files is not as expected');
        });

        mocha.it('by_symlinks:list iner dir', async function() {
            const res = await list_objects(ns, bucket, '/', 'ld2/', dummy_object_sdk);
            assert.strictEqual(res.objects.length, 0, 'amount of files is not as expected');
        });

        mocha.it('by_symlinks:list iner dir without delimiter', async function() {
            const res = await list_objects(ns, bucket, undefined, 'ld2/', dummy_object_sdk);
            assert.strictEqual(res.objects.length, 0, 'amount of files is not as expected');
        });

        mocha.it('by_symlinks:read_object_md', async function() {
            try {
                await read_object_md(ns, bucket, 'd2/f4', dummy_object_sdk);
            } catch (err) {
                assert.strictEqual(err.code, 'EACCES', 'read_object_md should return access denied');
            }
        });

        mocha.it('by_symlinks:read_object_stream', async function() {
            try {
                await read_object_stream(ns, bucket, 'ld2/f4', dummy_object_sdk);
            } catch (err) {
                assert.strictEqual(err.code, 'EACCES', 'read_object_stream should return access denied');
            }
        });

        mocha.it('by_symlinks:upload_object', async function() {
            const data = crypto.randomBytes(100);
            const source = buffer_utils.buffer_to_read_stream(data);
            try {
                await upload_object(ns, bucket, 'ld2/uploaded-file1', dummy_object_sdk, source);
            } catch (err) {
                assert.strictEqual(err.code, 'EACCES', 'upload_object should return access denied');
            }
        });

        mocha.it('by_symlinks:delete_object', async function() {
            try {
                await delete_object(ns, bucket, 'ld2/f5', dummy_object_sdk);
            } catch (err) {
                assert.strictEqual(err.code, 'EACCES', 'delete_object should return access denied');
            }
        });
    });


});

mocha.describe('namespace_fs copy object', function() {

    const src_bkt = 'src';
    const upload_bkt = 'test_ns_uploads_object';
    let tmp_fs_path = '/tmp/test_namespace_fs';
    if (process.platform === MAC_PLATFORM) {
        tmp_fs_path = '/private/' + tmp_fs_path;
    }
    const dummy_object_sdk = make_dummy_object_sdk();

    const ns_tmp_bucket_path = `${tmp_fs_path}/${src_bkt}`;

    const ns_tmp = new NamespaceFS({ bucket_path: ns_tmp_bucket_path, bucket_id: '3', namespace_resource_id: undefined });

    mocha.before(async () => {
        await P.all(_.map([src_bkt, upload_bkt], async buck =>
            fs_utils.create_fresh_path(`${tmp_fs_path}/${buck}`)));
    });
    mocha.after(async () => {
        await P.all(_.map([src_bkt, upload_bkt], async buck =>
            fs_utils.folder_delete(`${tmp_fs_path}/${buck}`)));
    });
    mocha.after(async () => fs_utils.folder_delete(tmp_fs_path));

    mocha.describe('upload_object (copy)', function() {
        const upload_key = 'upload_key_1';
        const copy_xattr = {};
        const copy_key_1 = 'copy_key_1';
        const data = crypto.randomBytes(100);

        mocha.before(async function() {
            const upload_res = await ns_tmp.upload_object({
                bucket: upload_bkt,
                key: upload_key,
                source_stream: buffer_utils.buffer_to_read_stream(data)
            }, dummy_object_sdk);
            // This is needed for the copy to work because we have a dummy_object_sdk that does not populate
            copy_xattr[XATTR_MD5_KEY] = upload_res.etag;
            console.log('upload_object response', inspect(upload_res));
        });

        mocha.it('copy, read of a small object copy - link flow', async function() {
            const params = {
                bucket: upload_bkt,
                key: copy_key_1,
                xattr: copy_xattr,
                copy_source: { key: upload_key }
            };
            const copy_res = await ns_tmp.upload_object(params, dummy_object_sdk);
            console.log('upload_object (copy) response', inspect(copy_res));

            const read_res = buffer_utils.write_stream();
            await ns_tmp.read_object_stream({
                bucket: upload_bkt,
                key: copy_key_1,
            }, dummy_object_sdk, read_res);
            console.log('read_object_stream (copy) response', inspect(read_res));
            const read_data = read_res.join();
            assert.strictEqual(Buffer.compare(read_data, data), 0);

            const delete_copy_res = await ns_tmp.delete_object({
                bucket: upload_bkt,
                key: copy_key_1,
            }, dummy_object_sdk);
            console.log('delete_object (copy) response', inspect(delete_copy_res));
        });

        mocha.it('copy, read of the small object twice to the same file name', async function() {
            const params = {
                bucket: upload_bkt,
                key: copy_key_1,
                xattr: copy_xattr,
                copy_source: {
                    key: upload_key,
                }
            };
            let copy_res = await ns_tmp.upload_object(params, dummy_object_sdk);
            console.log('upload_object: copy twice (1) to the same file name response', inspect(copy_res));

            copy_res = await ns_tmp.upload_object(params, dummy_object_sdk);
            console.log('upload_object: copy twice (2) to the same file name response', inspect(copy_res));

            const read_res = buffer_utils.write_stream();
            await ns_tmp.read_object_stream({
                bucket: upload_bkt,
                key: copy_key_1,
            }, dummy_object_sdk, read_res);
            console.log('read_object_stream: copy twice to the same file name response', inspect(read_res));
            const read_data = read_res.join();
            assert.strictEqual(Buffer.compare(read_data, data), 0);

            const delete_copy_res = await ns_tmp.delete_object({
                bucket: upload_bkt,
                key: copy_key_1,
            }, dummy_object_sdk);
            console.log('delete_object: copy twice to the same file name response', inspect(delete_copy_res));
        });

        mocha.after(async function() {
            const delete_res = await ns_tmp.delete_object({
                bucket: upload_bkt,
                key: upload_key,
            }, dummy_object_sdk);
            console.log('delete_object response', inspect(delete_res));
        });
    });

});

async function list_objects(ns, bucket, delimiter, prefix, dummy_object_sdk) {
    const res = await ns.list_objects({
        bucket: bucket,
        delimiter: delimiter,
        prefix: prefix,
    }, dummy_object_sdk);
    console.log(JSON.stringify(res));
    return res;
}

async function upload_object(ns, bucket, file_key, dummy_object_sdk, source) {
    const xattr = { key: 'value', key2: 'value2' };
    xattr[s3_utils.XATTR_SORT_SYMBOL] = true;
    const upload_res = await ns.upload_object({
        bucket: bucket,
        key: file_key,
        xattr,
        source_stream: source
    }, dummy_object_sdk);
    console.log('upload_object response', inspect(upload_res));
    return upload_object;
}

async function delete_object(ns, bucket, file_key, dummy_object_sdk) {
    const delete_copy_res = await ns.delete_object({
        bucket: bucket,
        key: file_key,
    }, dummy_object_sdk);
    console.log('delete_object do not delete the path response', inspect(delete_copy_res));
    return delete_copy_res;
}

async function read_object_md(ns, bucket, file_key, dummy_object_sdk) {
    const res = await ns.read_object_md({
        bucket: bucket,
        key: file_key,
    }, dummy_object_sdk);
    console.log(inspect(res));
    return res;
}

async function read_object_stream(ns, bucket, file_key, dummy_object_sdk) {
    const out = buffer_utils.write_stream();
    await ns.read_object_stream({
        bucket: bucket,
        key: file_key,
    }, dummy_object_sdk, out);
    console.log(inspect(out));
    return out;
}

function create_file(file_path) {
    return fs.promises.appendFile(file_path, file_path + '\n');
}

