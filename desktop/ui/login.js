const form = document.getElementById('login-form');
const password = document.getElementById('password');
const submit = document.getElementById('submit');
const status = document.getElementById('status');
const done = document.getElementById('done');
form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = '正在连接云端，请稍候……';
    const value = password.value.trim();
    password.value = '';
    try {
        const result = await window.desktopLogin.submit(value);
        status.textContent = result.message || (result.ok ? '登录成功。回到游戏后可下载云档或同步进度。' : '登录失败，请重试。');
        if (result.ok) { form.hidden = true; done.hidden = false; done.focus(); }
    } catch { status.textContent = '暂时无法登录。请检查网络，仍可关闭此窗口继续本地游戏。'; }
    finally { submit.disabled = false; }
});
done.addEventListener('click', () => window.desktopLogin.done());
