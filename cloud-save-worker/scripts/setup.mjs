import { createInterface } from 'node:readline/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';

const configUrl = new URL('../wrangler.local.json', import.meta.url);
const template = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
let previous;
try { previous = JSON.parse(await readFile(configUrl, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const rl = createInterface({ input: stdin, output: stdout });
async function ask(label, fallback, valid) {
    for (;;) {
        const answer = (await rl.question(label + (fallback ? ' [' + fallback + ']' : '') + '：')).trim() || fallback;
        if (valid(answer)) return answer;
        console.log('格式不正确，请按手册检查后重新输入。');
    }
}
try {
    console.log('此向导只填写公开配置，不需要 GitHub token。直接回车使用方括号内的值。');
    const domain = await ask('游戏域名（不带 https://）', previous?.vars.ALLOWED_ORIGIN?.replace('https://', '') || 'play.ggzz.fun',
        value => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value));
    const owner = await ask('GitHub 用户名', previous?.vars.GITHUB_OWNER || '', value => /^[a-z0-9][a-z0-9-]*$/i.test(value));
    const repo = await ask('私有存档仓库名', previous?.vars.GITHUB_SAVE_REPO || 'pokeclicker-saves', value => /^[\w.-]+$/.test(value));
    const branch = await ask('存档仓库分支', previous?.vars.GITHUB_SAVE_BRANCH || 'main', value => /^[\w./-]+$/.test(value));
    const team = await ask('Access 团队地址（完整 https://xxx.cloudflareaccess.com）', previous?.vars.ACCESS_TEAM_DOMAIN || '',
        value => /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(value));
    const aud = await ask('Access 应用 AUD', previous?.vars.ACCESS_AUD || '', value => /^[a-f0-9]{64}$/i.test(value));
    const email = await ask('唯一允许登录的邮箱', previous?.vars.ALLOWED_EMAIL || '', value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
    const config = {
        ...template,
        routes: [{ pattern: domain.toLowerCase(), custom_domain: true }],
        vars: {
            ...template.vars, GITHUB_OWNER: owner, GITHUB_SAVE_REPO: repo, GITHUB_SAVE_BRANCH: branch,
            CLOUD_SLOT_ID: previous?.vars.CLOUD_SLOT_ID || randomUUID(),
            ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: email.toLowerCase(),
            ALLOWED_ORIGIN: 'https://' + domain.toLowerCase(),
        },
    };
    await writeFile(configUrl, JSON.stringify(config, null, 4) + '\n', 'utf8');
    console.log('\n已保存：' + fileURLToPath(configUrl));
    console.log('云槽位 ID：' + config.vars.CLOUD_SLOT_ID + '（请和配置文件一起备份，更新时保持不变）');
    console.log('下一步按手册构建、登录 Cloudflare、部署，然后用 cloud:secret 安全录入 token。');
} finally {
    rl.close();
}
