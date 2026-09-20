import { createInterface } from 'node:readline/promises';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { stdin, stdout, argv } from 'node:process';

const rl = createInterface({ input: stdin, output: stdout });
try {
    const input = (argv[2] || await rl.question('把恢复备份包或 GitHub 存档 JSON 文件拖进窗口，然后按回车：')).trim().replace(/^"|"$/g, '');
    const file = resolve(input);
    const data = JSON.parse(await readFile(file, 'utf8'));
    const candidates = [];
    const add = (payload, label) => {
        if (payload?.player && payload?.save && typeof payload.player === 'object' && typeof payload.save === 'object') {
            candidates.push({ payload: { ...payload, settings: payload.settings || {} }, label });
        }
    };
    if (Array.isArray(data)) {
        data.forEach((entry, i) => {
            const label = String(i + 1).padStart(3, '0') + '-' + String(entry.time || 'unknown').replace(/[^0-9T-]/g, '-');
            if (Array.isArray(entry.local) && entry.local[0] && entry.local[1]) {
                add({ player: JSON.parse(entry.local[0]), save: JSON.parse(entry.local[1]), settings: JSON.parse(entry.local[2] || '{}') }, label + '-local');
            }
            if (entry.remote?.envelope?.payload) add(entry.remote.envelope.payload, label + '-cloud');
        });
    } else {
        add(data.payload || data, 'save');
    }
    if (!candidates.length) throw new Error('文件中没有可恢复的存档。');
    const output = resolve(dirname(file), basename(file, '.json') + '-recovered-' + Date.now());
    await mkdir(output, { recursive: true });
    for (const { payload, label } of candidates) {
        // Original PokéClicker uses Latin-1 Base64 with URI escaping for Unicode and percent signs.
        const text = JSON.stringify(payload).replace(/[^\u0000-\u00FF]+|%/g, value => encodeURI(value));
        await writeFile(resolve(output, label + '.txt'), Buffer.from(text, 'latin1').toString('base64'), 'utf8');
    }
    console.log('已生成 ' + candidates.length + ' 份原版 .txt 存档：' + output);
    console.log('文件名含备份时间；local 是当时本地进度，cloud 是当时云端进度。');
    console.log('请在游戏选档页用 Import Save 导入到新槽位，核对进度后再决定是否同步。原始备份文件未修改。');
} finally {
    rl.close();
}
