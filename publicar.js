// Publica a versão do package.json como GitHub Release (instalador + latest.yml + blockmap).
// Uso: defina GH_TOKEN e rode "npm run publicar".
// O "--publish always" do electron-builder 26 criava a release duas vezes ao mesmo tempo
// e falhava com "Published releases must have a valid tag"; aqui é uma chamada de cada vez.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pkg = require('./package.json');

const token = process.env.GH_TOKEN;
if (!token) { console.error('Defina GH_TOKEN antes: $env:GH_TOKEN = "seu_token"'); process.exit(1); }
const { owner, repo } = pkg.build.publish[0];
const versao = pkg.version;
const tag = 'v' + versao;
const instalador = `PainelDeScripts-Setup-${versao}.exe`;
const arquivos = [instalador, instalador + '.blockmap', 'latest.yml'].map(f => path.join('out', f));

const api = async (metodo, url, corpo, tipo = 'application/json') => {
    const r = await fetch(url, {
        method: metodo,
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': tipo },
        body: corpo
    });
    if (!r.ok) throw new Error(`${metodo} ${url}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
};

(async () => {
    for (const f of ['latest.yml', instalador]) fs.rmSync(path.join('out', f), { force: true });
    execSync('npm run build && npx electron-builder --win --publish never', { stdio: 'inherit' });
    for (const f of arquivos) if (!fs.existsSync(f)) throw new Error('Não foi gerado: ' + f);
    if (!fs.readFileSync('out/latest.yml', 'utf8').includes(`version: ${versao}`)) throw new Error('out/latest.yml não é da versão ' + versao);

    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const existentes = await api('GET', `${base}/releases?per_page=100`);
    if (existentes.some(r => r.tag_name === tag)) throw new Error(`Já existe a release ${tag}. Aumente a "version" no package.json.`);

    // Cria como rascunho, sobe os arquivos e só então publica: ninguém recebe uma release pela metade.
    const rel = await api('POST', `${base}/releases`, JSON.stringify({ tag_name: tag, target_commitish: 'main', name: `${pkg.build.productName} ${versao}`, body: process.env.NOTAS || `${pkg.build.productName} ${versao}`, draft: true }));
    for (const f of arquivos) {
        console.log('Enviando', path.basename(f), `(${Math.round(fs.statSync(f).size / 1048576)} MB)...`);
        await api('POST', `https://uploads.github.com/repos/${owner}/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(path.basename(f))}`,
            fs.readFileSync(f), 'application/octet-stream');
    }
    const pub = await api('PATCH', `${base}/releases/${rel.id}`, JSON.stringify({ draft: false, make_latest: 'true' }));
    console.log('Publicado:', pub.html_url);
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
