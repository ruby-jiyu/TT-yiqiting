const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../index.js'), 'utf8');
const calls = [], messages = [], prompts = [];
let mode = 'reco', failure = '', delayed, release, songRequests = 0;
const saved = { value: '' };
const context = {
    extensionSettings: {}, characterId: 0,
    characters: [
        { name: '同名角色', avatar: 'a.png', data: { description: '角色A设定', personality: '温柔' } },
        { name: '同名角色', avatar: 'b.png', data: { description: '角色B设定', personality: '冷静' } },
    ],
    chat: [{ is_user: true, mes: '今天想听歌' }], name1: '用户',
    saveSettingsDebounced() { saved.value = JSON.stringify(context.extensionSettings); },
    eventSource: { on() {} }, eventTypes: { CHAT_CHANGED: 'chat', GENERATION_AFTER_COMMANDS: 'generate' },
    setExtensionPrompt(...args) { prompts.push(args); },
};
const sandbox = vm.createContext({
    SillyTavern: { getContext: () => context }, URL, AbortSignal, console, setTimeout, clearTimeout, setInterval, clearInterval,
    Audio: class {
        constructor() { this.listeners = {}; this.src = ''; this.volume = 1; this.paused = true; }
        addEventListener(name, cb) { this.listeners[name] = cb; }
        pause() { this.paused = true; this.listeners.pause?.(); }
        async play() { this.paused = false; this.listeners.play?.(); }
    },
    fetch: async (value, options = {}) => {
        const url = new URL(value);
        calls.push({ url, options });
        if (url.host === 'ai.test') {
            if (delayed) { const wait = delayed; delayed = null; await wait; }
            if (failure === 'non-json') return { ok: false, status: 502, json: async () => { throw Error('HTML'); } };
            if (failure === 'auth') return { ok: false, status: 401, json: async () => ({ error: { message: 'invalid key' } }) };
            const body = JSON.parse(options.body);
            let content = 'ok';
            if (body.max_tokens === 1200) {
                if (mode === 'bad') content = 'invalid json';
                else content = JSON.stringify(mode === 'like'
                    ? [{ name: '喜欢歌', artist: '歌手乙', reason: '偏好' }]
                    : [{ name: '推荐歌', artist: '歌手甲', reason: '<img src=x>' }, { name: '推荐歌', artist: '歌手甲' }, { name: '第二首', artist: '歌手甲' }, { name: '同名歌', artist: '正确歌手' }]);
            }
            if (body.max_tokens === 500) content = '1. 我喜欢。\n2. 想与你分享。';
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
        }
        let data;
        if (failure === 'music') data = { code: 500, message: '音乐服务故障' };
        else if (url.pathname === '/song/url') { songRequests++; data = { code: 200, data: [{ url: null }] }; }
        else if (url.pathname === '/playlist/track/all') data = { code: 200, songs: [{ id: 5, name: '绑定的歌', ar: [{ name: '歌手丙' }], al: { name: '专辑' } }] };
        else {
            const name = (url.searchParams.get('keywords') || '').split(' ')[0];
            const artist = name === '同名歌' ? '错误歌手' : name === '喜欢歌' ? '歌手乙' : '歌手甲';
            data = { code: 200, result: { songs: [{ id: name === '第二首' ? 2 : name === '喜欢歌' ? 3 : 1, name, artists: [{ name: artist }], album: {} }] } };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    },
    testMessages: messages,
});
vm.runInContext(source.replace(/init\(\)\.catch\(.*\);\s*$/, ''), sandbox);
vm.runInContext('toast = msg => testMessages.push(msg); renderRoleView = () => {}; renderThoughtSongs = () => {}; syncPlayUI = () => {}; updateSongInfo = () => {};', sandbox);
const run = code => vm.runInContext(code, sandbox);
(async () => {
    assert.equal(run("aiEndpoint('https://ai.test/v1/')"), 'https://ai.test/v1/chat/completions');
    assert.equal(run("aiEndpoint('https://ai.test/v1/chat/completions/')"), 'https://ai.test/v1/chat/completions');
    assert.equal(run("aiEndpoint('https://ai.test/')"), 'https://ai.test/chat/completions');
    assert.throws(() => run("aiEndpoint('javascript:alert(1)')"));
    assert.equal(run('getCurrentChar().data.description'), '角色A设定');
    context.groupId = 'group';
    assert.equal(run('getCurrentChar()'), null);
    context.groupId = null;
    assert(run('characterInfo(getCurrentChar())').includes('今天想听歌'));
    assert(run('characterInfo(getCurrentChar())').includes('温柔'));
    run("Object.assign(getSettings(), {aiApiBase:'https://ai.test/v1', aiApiKey:'independent-key', aiModel:'independent-model', apiBase:'https://music.test', autoplayOnCharChange:false})");
    await run("callAI([{role:'user',content:'ok'}])");
    assert.equal(JSON.parse(calls.at(-1).options.body).model, 'independent-model');
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer independent-key');
    failure = 'auth';
    await assert.rejects(run("callAI([])"), /invalid key/);
    failure = 'non-json';
    await assert.rejects(run("callAI([])"), /未返回 JSON/);
    failure = '';
    await run("recommendSongsForChar()");
    assert.equal(run("getCharExt(getCurrentChar()).recommendations.length"), 2);
    const initial = run("JSON.stringify(getCharExt(getCurrentChar()).recommendations)");
    mode = 'bad';
    await run("recommendSongsForChar()");
    assert.equal(run("JSON.stringify(getCharExt(getCurrentChar()).recommendations)"), initial);
    mode = 'reco';
    delayed = new Promise(resolve => { release = resolve; });
    const pending = run("recommendSongsForChar()");
    context.characterId = 1;
    assert.equal(run("getCharExt(getCurrentChar()).recommendations.length"), 0);
    release();
    await pending;
    assert.equal(run("getCharExt(getCurrentChar()).recommendations.length"), 0);
    assert.equal(run("getCharExt(getContext().characters[0]).recommendations.length"), 2);
    mode = 'like';
    await run("recommendSongsForChar('like')");
    assert.equal(run("getCharExt(getCurrentChar()).favoriteSongs[0].name"), '喜欢歌');
    await run("playTrack(0, [{id:99,name:'随便播放的歌',artist:'其他人'},{id:100,name:'另一首',artist:'其他人'}])");
    assert.equal(songRequests, 2, 'unplayable queue stops after one pass');
    assert.equal(run("getThoughtSongs('like')[0].name"), '喜欢歌');
    await run("generateThought('like')");
    assert.equal(run("getCharExt(getCurrentChar()).thoughts.like"), '1. 我喜欢。\n2. 想与你分享。');
    const prompt = JSON.parse(calls.filter(c => c.url.host === 'ai.test').at(-1).options.body).messages[1].content;
    assert(prompt.includes('喜欢歌'));
    assert(!prompt.includes('随便播放的歌'));
    await run("setCharPlaylist(getCurrentChar(),123,'绑定歌单')");
    assert.equal(run("getThoughtSongs('like')[0].name"), '绑定的歌');
    context.characterId = 0;
    run("toggleFavorite(getCharExt(getCurrentChar()).recommendations[0])");
    assert.equal(run("getThoughtSongs('like').length"), 1);
    run("toggleFavorite(getCharExt(getCurrentChar()).recommendations[0])");
    assert.equal(run("getThoughtSongs('like').length"), 0);
    failure = 'music';
    await run("recommendSongsForChar('like')");
    assert.equal(run("getThoughtSongs('like').length"), 0);
    failure = '';
    run("getSettings().cookie = 'MUSIC_U=test-cookie'");
    await run("searchSongs('hello')");
    assert.equal(calls.at(-1).url.searchParams.get('cookie'), 'MUSIC_U=test-cookie');
    assert.equal(calls.at(-1).options.credentials, 'omit');
    assert.equal(calls.at(-1).options.headers, undefined);
    const restored = JSON.parse(saved.value);
    assert.equal(restored.netease_music.characters['a.png'].recommendations.length, 2);
    assert.equal(restored.netease_music.characters['b.png'].favoriteSongs[0].name, '绑定的歌');
    context.extensionSettings.netease_music = restored.netease_music;
    assert.equal(run("getCharExt(getContext().characters[1]).favoriteSongs[0].name"), '绑定的歌');
    assert.equal(run("escapeHtml('<img src=x onerror=\"evil\">')"), '&lt;img src=x onerror=&quot;evil&quot;&gt;');
    run("state.playlist=[{name:'正在听的歌',artist:'歌手'}]; state.currentIndex=0; state.audio.src='https://music.test/audio'; state.isPlaying=true; injectSongToContext()");
    assert(prompts.at(-1)[1].includes('正在听的歌'));
    run("getSettings().injectSong=false; injectSongToContext()");
    assert.equal(prompts.at(-1)[1], '');
    assert.equal(run("aiJobs.size"), 0);
    console.log('PASS: independent API, endpoint formats, errors, role context, same-name character isolation, late responses, saved favorites, playlist binding, matching, deduplication, cookie transport, escaped text, and song injection');
})().catch(error => { console.error(error); process.exitCode = 1; });

