const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const src = path.join(__dirname, 'knowledge-graph.json');
const out = path.join(__dirname, 'knowledge-graph-fs.json');

const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const nodes = data.nodes || [];

function getGitCommitHash() {
    try {
        return execSync('git rev-parse HEAD', {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8'
        }).trim();
    } catch {
        return 'unknown';
    }
}

const dirMap = new Map();
const edges = data.edges || [];

function ensureDirNode(dirPath) {
    if (dirMap.has(dirPath)) return dirMap.get(dirPath);
    const id = 'dir:' + dirPath.replace(/\\/g, '/');
    const name = path.basename(dirPath) || '/';
    const node = {
        id,
        type: 'module',
        name,
        filePath: dirPath,
        summary: `Thu muc ${name} trong cay thu muc du an`,
        title: name,
        tags: ['directory']
    };
    dirMap.set(dirPath, node);
    return node;
}

// For each file node, create directory nodes for its path and add contains edges
nodes.forEach(n => {
    const filePath = n.filePath || n.path || n.name;
    if (!filePath) return;
    const parts = filePath.split(/[\\/]+/).filter(Boolean);
    let accum = '';
    for (let i = 0; i < parts.length - 0; i++) {
        const part = parts[i];
        accum = accum ? path.posix.join(accum, part) : part;
        // create directory node for accum except when accum equals full file name? We want directories only
        const isFile = i === parts.length - 1 && n.type === 'file';
        const dirPath = i < parts.length - 1 ? path.posix.join(parts.slice(0, i + 1).join('/')) : parts.slice(0, -1).join('/');
    }
    // simpler: take dirname
    const dirname = path.posix.dirname(filePath);
    if (dirname && dirname !== '.' && dirname !== '/') {
        // create chain of directories
        const segs = dirname.split('/').filter(Boolean);
        let p = '';
        for (let i = 0; i < segs.length; i++) {
            p = p ? p + '/' + segs[i] : segs[i];
            ensureDirNode(p);
            if (i > 0) {
                const parent = 'dir:' + segs.slice(0, i).join('/');
                const child = 'dir:' + p;
                edges.push({ source: parent, target: child, type: 'contains' });
            }
        }
        // add edge from last dir to file node
        const lastDirId = 'dir:' + segs.join('/');
        edges.push({ source: lastDirId, target: n.id, type: 'contains' });
    } else {
        // file at repo root -> connect to root dir
        const rootId = 'dir:';
        if (!dirMap.has('')) ensureDirNode('');
        edges.push({ source: 'dir:', target: n.id, type: 'contains' });
    }
});

const dirNodes = Array.from(dirMap.values());

const outGraph = Object.assign({}, data, {
    kind: data.kind || 'codebase',
    project: Object.assign({}, data.project || {}, {
        analyzedAt: data.project?.analyzedAt || new Date().toISOString(),
        gitCommitHash: data.project?.gitCommitHash || getGitCommitHash()
    }),
    nodes: dirNodes.concat(nodes),
    edges: (data.edges || []).concat(edges),
    metadata: Object.assign({}, data.metadata || {}, { generatedBy: 'augment_graph_fs.js', generatedAt: new Date().toISOString() })
});

fs.writeFileSync(out, JSON.stringify(outGraph, null, 2), 'utf8');
console.log('Wrote', out);
