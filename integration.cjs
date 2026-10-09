const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 800 }, hasTouch: true });
        const errors = [], requests = [];
        let aiMode = 'recommend', hold, release, musicFail = false, aiFailure = '';
        page.on('pageerror', e => errors.push(e.message));
        const json = (route, data, status = 200) => route.fulfill({
            status, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(data),
        });
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname === 'st.test') return route.fulfill({ contentType: 'text/html', body: '<div id="extensions_settings"></div><textarea id="send_textarea"></textarea><button id="send_but"></button>' });
            if (url.hostname === 'ai.test') {
                const body = route.request().postDataJSON();
                requests.push({ url: url.href, headers: route.request().headers(), body });
                if (hold) { const promise = hold; hold = null; await promise; }
                if (aiFailure) return route.fulfill({ status: 500, contentType: 'text/html', body: aiFailure });
                let content = 'ok';
                if (body.max_tokens === 1200) {
                    if (aiMode === 'bad') content = 'this is not JSON';
                    else if (aiMode === 'like') content = JSON.stringify([{ name: '喜欢歌', artist: '歌手乙', reason: '这是我的偏好' }]);
                    else content = String.fromCharCode(96).repeat(3) + 'json\n' + JSON.stringify([
                        { name: '推荐歌', artist: '歌手甲', reason: '<img src=x onerror="window.injected=true">' },
                        { name: '推荐歌', artist: '歌手甲', reason: '重复' },
                        { name: '第二首', artist: '歌手甲', reason: '想分享给你' },
                        { name: '同名歌', artist: '正确歌手', reason: '应跳过错误歌手' },
                    ]) + '\n' + String.fromCharCode(96).repeat(3);
                }
                if (body.max_tokens === 500) content = '1. <img src=x onerror="window.injected=true">很适合我。\n2. 我喜欢。';
                return json(route, { choices: [{ message: { content } }] });
            }
            if (url.hostname === 'music.test') {
                if (musicFail) return json(route, { code: 500, message: '音乐服务故障' });
                if (url.pathname === '/song/url') return json(route, { code: 200, data: [{ url: null }] });
                if (url.pathname === '/playlist/track/all') return json(route, { code: 200, songs: [{ id: 5, name: '绑定的歌', ar: [{ name: '歌手丙' }], al: { name: '专辑' } }] });
                const keyword = url.searchParams.get('keywords') || '';
                const [name] = keyword.split(' ');
                const id = name === '喜欢歌' ? 3 : name === '第二首' ? 2 : 1;
                const artist = name === '同名歌' ? '错误歌手' : name === '喜欢歌' ? '歌手乙' : '歌手甲';
                return json(route, { code: 200, result: { songs: [{ id, name, artists: [{ name: artist }], album: {} }] } });
            }
            return route.abort();
        });
        await page.goto('http://st.test/');
        await page.evaluate(() => {
            window.ctx = {
                extensionSettings: {},
                characters: [
                    { name: '同名角色', avatar: 'a.png', data: { description: '角色A设定', personality: '温柔' } },
                    { name: '同名角色', avatar: 'b.png', data: { description: '角色B设定', personality: '冷静' } },
                ],
                characterId: null,
                chat: [{ is_user: true, mes: '今天想听歌' }], name1: '用户',
                saveSettingsDebounced: () => localStorage.setItem('nm-settings', JSON.stringify(ctx.extensionSettings)),
                eventTypes: { CHAT_CHANGED: 'chat', GENERATION_AFTER_COMMANDS: 'generate' },
                eventSource: {
                    callbacks: {},
                    on(name, cb) { if (!name) throw new Error('Invalid event'); (this.callbacks[name] ||= []).push(cb); },
                    async emit(name) { for (const cb of this.callbacks[name] || []) await cb(); },
                },
                setExtensionPrompt: (...args) => { window.songPrompt = args; },
            };
            window.SillyTavern = { getContext: () => window.ctx };
            window.jQuery = element => ({ val(value) { element.value = value; return this; }, trigger() { return this; } });
        });
        await page.addStyleTag({ path: path.resolve(__dirname, '../index.css') });
        await page.addScriptTag({ path: path.resolve(__dirname, '../index.js') });
        assert.deepEqual(errors, []);
        const orbBox = await page.locator('#nm-orb').boundingBox();
        await page.touchscreen.tap(orbBox.x + orbBox.width / 2, orbBox.y + orbBox.height / 2);
        assert.equal(await page.locator('#nm-panel').isVisible(), true);
        await page.touchscreen.tap(orbBox.x + orbBox.width / 2, orbBox.y + orbBox.height / 2);
        assert.equal(await page.locator('#nm-panel').isVisible(), false, 'one mobile tap closes once');
        await page.click('#nm-orb');
        await page.click('[data-view="login"]');
        await page.fill('#nm-ai-base', 'https://ai.test/v1/chat/completions/');
        await page.fill('#nm-ai-key', 'test-independent-key');
        await page.fill('#nm-ai-model', 'independent-model');
        await page.click('#nm-ai-test');
        await page.waitForFunction(() => document.querySelector('#nm-ai-status').textContent.includes('成功'));
        assert.equal(await page.evaluate(() => ctx.extensionSettings.netease_music.aiModel), '');
        assert.equal(requests.at(-1).url, 'https://ai.test/v1/chat/completions');
        await page.click('#nm-ai-save');
        await page.fill('#nm-api-base', 'https://music.test');
        await page.locator('#nm-api-base').blur();
        assert.equal(await page.inputValue('#nm-set-ai-model'), 'independent-model');
        assert.equal(await page.evaluate(() => aiEndpoint('https://ai.test/v1/')), 'https://ai.test/v1/chat/completions');
        assert.equal(await page.evaluate(() => aiEndpoint('https://ai.test/')), 'https://ai.test/chat/completions');
        await page.evaluate(async () => { ctx.characterId = 0; getSettings().autoplayOnCharChange = false; await ctx.eventSource.emit('chat'); });
        await page.click('[data-view="role"]');
        await page.click('#nm-reco-btn');
        await page.waitForFunction(() => !document.querySelector('#nm-reco-btn').disabled);
        assert.equal(await page.locator('.nm-reco-card').count(), 2);
        assert.equal(await page.locator('.nm-reco-reason img').count(), 0);
        assert.equal(requests.at(-1).body.model, 'independent-model');
        assert.equal(requests.at(-1).headers.authorization, 'Bearer test-independent-key');
        assert(requests.at(-1).body.messages[1].content.includes('角色A设定'));
        assert(requests.at(-1).body.messages[1].content.includes('今天想听歌'));
        const recosA = await page.evaluate(() => JSON.stringify(getCharExt(getCurrentChar()).recommendations));
        aiMode = 'bad';
        await page.click('#nm-reco-btn');
        await page.waitForFunction(() => !document.querySelector('#nm-reco-btn').disabled);
        assert.equal(await page.evaluate(() => JSON.stringify(getCharExt(getCurrentChar()).recommendations)), recosA);
        aiMode = 'recommend';
        hold = new Promise(resolve => { release = resolve; });
        const before = requests.length;
        await page.click('#nm-reco-btn');
        await page.waitForFunction(() => document.querySelector('#nm-reco-btn').disabled);
        while (requests.length === before) await new Promise(resolve => setTimeout(resolve, 10));
        await page.evaluate(async () => { ctx.characterId = 1; await ctx.eventSource.emit('chat'); });
        assert.equal(await page.locator('.nm-reco-card').count(), 0);
        release();
        await page.waitForFunction(() => aiJobs.size === 0);
        assert.equal(await page.locator('.nm-reco-card').count(), 0);
        assert.equal(await page.evaluate(() => ctx.extensionSettings.netease_music.characters['b.png'].recommendations.length), 0);
        aiMode = 'like';
        await page.click('[data-sub="like"]');
        await page.click('#nm-like-btn');
        await page.waitForFunction(() => !document.querySelector('#nm-like-btn').disabled);
        assert((await page.textContent('#nm-role-list')).includes('喜欢歌'));
        await page.evaluate(async () => { await playTrack(0, [{ id: 99, name: '随便播放的歌', artist: '其他人' }]); });
        assert((await page.textContent('#nm-role-list')).includes('喜欢歌'));
        assert(!(await page.textContent('#nm-role-list')).includes('随便播放的歌'));
        await page.click('[data-sub="thought"]');
        await page.click('#nm-thought-like-btn');
        await page.waitForFunction(() => !document.querySelector('#nm-thought-like-btn').disabled);
        assert(requests.at(-1).body.messages[1].content.includes('喜欢歌'));
        assert(!requests.at(-1).body.messages[1].content.includes('随便播放的歌'));
        assert.equal(await page.locator('#nm-thought-like-result img').count(), 0);
        await page.evaluate(async () => { await setCharPlaylist(getCurrentChar(), 123, '绑定歌单'); });
        assert.equal(await page.evaluate(() => getCharExt(getCurrentChar()).favoriteSongs[0].name), '绑定的歌');
        await page.evaluate(async () => { ctx.characterId = 0; await ctx.eventSource.emit('chat'); });
        assert.equal(await page.locator('.nm-reco-card').count(), 2);
        await page.click('[data-sub="reco"]');
        await page.locator('.nm-reco-card [data-favorite]').first().click();
        assert.equal(await page.evaluate(() => getCharExt(getCurrentChar()).favoriteSongs.length), 1);
        await page.click('[data-sub="like"]');
        await page.locator('#nm-role-list [data-remove]').first().click();
        assert.equal(await page.evaluate(() => getCharExt(getCurrentChar()).favoriteSongs.length), 0);
        musicFail = true;
        await page.evaluate(async () => { await recommendSongsForChar('like'); });
        assert.equal(await page.evaluate(() => getCharExt(getCurrentChar()).favoriteSongs.length), 0);
        musicFail = false;
        aiFailure = 'bad gateway';
        await page.click('[data-view="login"]');
        await page.click('#nm-ai-test');
        await page.waitForFunction(() => document.querySelector('#nm-ai-status').textContent.includes('未返回 JSON'));
        assert.equal(await page.locator('#nm-ai-test').isEnabled(), true);
        aiFailure = '';
        const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('nm-settings')));
        await page.evaluate(persisted => { ctx.extensionSettings.netease_music = JSON.parse(JSON.stringify(persisted.netease_music)); renderRoleView(); }, persisted);
        assert.equal(await page.evaluate(() => getCharExt(ctx.characters[1]).favoriteSongs[0].name), '绑定的歌');
        assert.equal(await page.evaluate(() => getCharExt(ctx.characters[0]).recommendations.length), 2);
        await page.evaluate(() => { state.playlist = [{ name: '现在听的歌', artist: '歌手' }]; state.currentIndex = 0; state.audio.src = 'https://music.test/track.mp3'; state.isPlaying = true; injectSongToContext(); });
        assert((await page.evaluate(() => songPrompt[1])).includes('现在听的歌'));
        await page.evaluate(() => { getSettings().injectSong = false; injectSongToContext(); });
        assert.equal(await page.evaluate(() => songPrompt[1]), '');
        assert.deepEqual(errors, []);
        await page.click('[data-view="role"]');
        await page.click('[data-sub="reco"]');
        await page.click('#nm-close-panel');
        assert.equal(await page.locator('#nm-panel').isVisible(), false);
        await page.locator('#nm-orb').press('Enter');
        assert.equal(await page.locator('#nm-panel').isVisible(), true);
        await page.click('#nm-hide-orb');
        assert.equal(await page.locator('#nm-wrap').isVisible(), false);
        assert.equal(await page.locator('#nm-set-show-orb').isChecked(), false);
        await page.locator('#nm-set-show-orb').check();
        assert.equal(await page.locator('#nm-wrap').isVisible(), true);
        await page.click('#nm-orb');
        await page.screenshot({ path: path.resolve(__dirname, '../../preview.png') });
        console.log('PASS: independent configuration, API errors, character isolation, persistence, matching, favorites, thoughts, escaping, and song context');
    } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });

