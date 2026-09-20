const fs = require('node:fs/promises');
const path = require('node:path');

async function stage() {
    const root = path.resolve(__dirname, '../..');
    const destination = path.resolve(__dirname, '../.stage/game');
    // Only replace this generated directory; never touch userData or the source build.
    if (destination !== path.join(root, 'desktop', '.stage', 'game')) throw new Error('Invalid staging directory');
    await fs.access(path.join(root, 'docs', 'index.html'));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(path.join(root, 'docs'), destination, { recursive: true });
    for (const name of ['index.html', 'scripts/script.min.js', 'scripts/modules.min.js']) {
        const file = path.join(destination, name);
        let text = await fs.readFile(file, 'utf8');
        text = text.replaceAll('https://bootswatch.com/4/', './vendor/themes/');
        text = text.replaceAll('https://translations.pokeclicker.com', '.');
        // Keep credit names and links while avoiding remote decorative badges/avatars.
        text = text.replace(/<img\s+alt="([^"]*)"\s+src="https:\/\/img\.shields\.io\/[^"]*">/g, '<span class="badge badge-dark p-2">$1</span>');
        text = text.replace(/https:\/\/(?:a\.deviantart\.net\/avatars-big|avatars\.githubusercontent\.com|www\.smogon\.com\/forums\/(?:media|data\/avatars)|data\.pokecommunity\.com\/avatars)\/[^"'`\s<>\\]+/g, './assets/images/favicon.ico');
        await fs.writeFile(file, text);
    }
    const themes = path.resolve(__dirname, '../node_modules/bootswatch/dist');
    for (const entry of await fs.readdir(themes, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = path.join(themes, entry.name, 'bootstrap.min.css');
        try {
            // Font imports would otherwise depend on Google Fonts when offline.
            const css = (await fs.readFile(source, 'utf8')).replace(/@import\s+url\([^)]*\);?/g, '');
            const target = path.join(destination, 'vendor/themes', entry.name);
            await fs.mkdir(target, { recursive: true });
            await fs.writeFile(path.join(target, 'bootstrap.min.css'), css);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.copyFile(path.resolve(__dirname, '../node_modules/bootswatch/LICENSE'), path.join(destination, 'vendor/themes/LICENSE'));
    const game = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const desktop = JSON.parse(await fs.readFile(path.resolve(__dirname, '../package.json'), 'utf8'));
    await fs.writeFile(path.join(destination, 'desktop-build.json'), JSON.stringify({
        desktopVersion: desktop.version, gameVersion: game.version, cloudOrigin: 'https://play.ggzz.fun',
    }, null, 2));
    console.log(`Staged local game ${game.version} for desktop ${desktop.version}.`);
}
stage().catch(error => { console.error(error.message); process.exitCode = 1; });
