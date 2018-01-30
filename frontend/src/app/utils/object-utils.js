/* Copyright (C) 2016 NooBaa */

import { deepFreeze, unique, groupBy } from 'utils/core-utils';
import { stringifyAmount } from 'utils/string-utils';

const resiliencyTypeToBlockTypes = deepFreeze({
    REPLICATION: [
        'REPLICA'
    ],
    ERASURE_CODING: [
        'DATA',
        'PARITY'
    ]
});

export function getObjectId(bucket, key, uploadId) {
    return uploadId ?
        `${bucket}:${key}:${uploadId}` :
        `${bucket}:${key}`;
}

export function summerizePartDistribution(bucket, part) {
    const { resiliency, placement, spillover } = bucket;

    const placementMirroSets = placement.mirrorSets
        .map(mirrorSet => mirrorSet.name);

    const blocksByGorupId = groupBy(
        part.blocks,
        block => _getBlockGroupID(
            block,
            placementMirroSets,
            spillover && spillover.mirrorSet,
            resiliency.kind
        ),
    );

    const groups = placement.mirrorSets
        .map((mirrorSet, index) => {
            const type = 'MIRROR_SET';
            const { name, resources } = mirrorSet;
            const realBlocks = blocksByGorupId[name] || [];
            const storagePolicy = _findStoragePolicy(resources, resiliency, realBlocks);
            const blocks = _fillInMissingBlocks(realBlocks, storagePolicy);
            return { type, index, storagePolicy, resources, blocks };
        });

    const spilloverBlocks = blocksByGorupId['SPILLOVER'];
    if (spilloverBlocks) {
        groups.push({
            type: 'SPILLOVER_SET',
            index: groups.length,
            storagePolicy: _countBlocksByType(spilloverBlocks),
            blocks: spilloverBlocks,
            resources: []
        });
    }

    const removedBlocks = blocksByGorupId['REMOVED'];
    if (removedBlocks) {
        const blocks = removedBlocks
            .map(block => {
                if (block.mode !== 'HEALTHY') {
                    return block;
                }

                return {
                    ...block,
                    mode: 'WIPING'
                };
            });

        groups.push({
            type: 'TO_BE_REMOVED',
            index: groups.length,
            storagePolicy: _countBlocksByType(removedBlocks),
            blocks: blocks,
            resources: []
        });
    }

    return groups;
}

export function formatBlockDistribution(counters, seperator = ' | ') {
    const {
        replicas = 0,
        dataFrags = 0,
        parityFrags = 0,
        toBeRemoved = 0
    } = counters;

    const parts = [];
    if (replicas > 0) {
        parts.push(stringifyAmount('Replica', replicas));
    }

    if (dataFrags > 0) {
        parts.push(stringifyAmount('Data Fragment', dataFrags));
    }

    if (parityFrags > 0) {
        parts.push(stringifyAmount('Parity Fragment', parityFrags));
    }

    if (toBeRemoved > 0) {
        parts.push(`To Be Removed: ${stringifyAmount('block', toBeRemoved)}`);
    }

    return parts.join(seperator);
}

function _getStorageType(resources, blocks) {
    const types = unique(resources.map(res => res.type));
    if (types.length === 1) return types[0];

    const [candidate] = blocks;
    if (candidate) return candidate.storage.kind;

    return 'HOSTS';
}

function _mockBlock(kind, seq) {
    const mode = 'MOCKED';
    return { kind, seq, mode };
}

function _findStoragePolicy(resources, resiliency, blocks) {
    const storageType = _getStorageType(resources, blocks);
    if (resiliency.kind === 'REPLICATION') {
        if (storageType === 'HOSTS') {
            return {
                replicas: resiliency.replicas,
                dataFrags: 0,
                parityFrags: 0
            };

        } else {
            return {
                replicas: 1,
                dataFrags: 0,
                parityFrags: 0
            };
        }
    } else {
        if (storageType === 'HOSTS') {
            return {
                replicas: 0,
                dataFrags: resiliency.dataFrags,
                parityFrags: resiliency.parityFrags
            };

        } else {
            return {
                replicas: 0,
                dataFrags: resiliency.dataFrags,
                parityFrags: 0
            };
        }
    }
}

function _fillInFragBlocks(blocks, target, fragType) {
    const bySeq = groupBy(blocks, block => block.seq);
    const result = [];
    let i = 0;
    while (result.length < target) {
        if (bySeq[i]) {
            result.push(...bySeq[i]);
        } else {
            result.push(_mockBlock(fragType, i));
        }
        ++i;
    }
    return result;
}

function _fillInMissingBlocks(blocks, storagePolicy) {
    const { replicas, dataFrags, parityFrags } = storagePolicy;

    let {
        REPLICA: replicaBlocks = [],
        DATA: dataBlocks = [],
        PARITY: parityBlocks = []
    } = groupBy(blocks, block => block.kind);

    if (replicas > 0) {
        replicaBlocks = new Array(Math.max(replicas, replicaBlocks.length))
            .fill(true)
            .map((_, i) =>
                replicaBlocks[i] ||
                _mockBlock('REPLICA')
            );
    }

    if (dataFrags > 0) {
        dataBlocks = _fillInFragBlocks(dataBlocks, dataFrags, 'DATA');
    }

    if (parityFrags > 0) {
        dataBlocks = _fillInFragBlocks(parityBlocks, parityFrags, 'PARITY');
    }

    return [
        ...replicaBlocks,
        ...dataBlocks,
        ...parityBlocks
    ];
}

function _getBlockGroupID(block, placementMirroSets, spilloverMirrorSet, resiliencyType) {
    const allowedBlockType = resiliencyTypeToBlockTypes[resiliencyType];
    return true &&
        // Block does not match a mirror set in the bucket.
        (!block.mirrorSet && 'REMOVED') ||

        // Block was not rebuild after resilency change
        (!allowedBlockType.includes(block.kind) && 'REMOVED') ||

        // Here to help find bug if block to mirror set mappings.
        (!placementMirroSets.includes(block.mirrorSet) && 'REMOVED') ||

        // Block is written to spillover.
        (block.mirrorSet === spilloverMirrorSet && 'SPILLOVER') ||

        // Block group id is the mirror set id.
        block.mirrorSet;
}

function _countBlocksByType(blocks) {
    return blocks.reduce(
        (counters, block) => {
            if (block.kind === 'REPLICA') ++counters.replicas;
            else if (block.kind === 'DATA') ++counters.replicas;
            else if (block.kind === 'PARITY') ++counters.replicas;
            return counters;
        },
        {
            replicas: 0,
            dataFrags:  0,
            parityFrags: 0
        }
    );
}
