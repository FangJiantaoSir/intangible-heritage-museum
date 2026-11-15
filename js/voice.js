/* ============================================================================
 * voice.js —— 非遗数字化虚拟体验馆 · 语音交互模块
 * 负责人：王迪（语音交互 / 用户测试）
 *
 * 技术：Web Speech API（SpeechRecognition / webkitSpeechRecognition）
 *       + 语音合成（SpeechSynthesis）
 * 能力：
 *   1. 语音指令意图匹配（含同义表达、最长匹配、去重、锁定窗口）
 *   2. 四类状态反馈（未授权 / 聆听中 / 识别成功 / 识别失败 / 指令不支持）
 *   3. 失败自动重试与示例提示，连续失败自动弹出指令帮助
 *   4. 语音播报（TTS），播报期间暂停识别，避免自我触发
 *   5. 多模态协同：语音执行后 1.2s 输入锁，避免与鼠标/手势重复触发
 *   6. 识别日志（localStorage），可导出 CSV 供用户测试统计识别成功率
 *   7. 无麦克风/不支持时可切换为文字模拟输入，保证测试与演示可继续
 *
 * 用法（在各展馆页面底部新增一段 <script>）：
 *   HciVoice.init({
 *     hall: '剪纸',
 *     tips: ['换红色', '剪个福字', '清空画布'],
 *     intents: [ { id, label, type, examples, keywords, action, reply } ]
 *   });
 * ========================================================================== */
(function (global) {
    'use strict';

    var LOG_KEY = 'hci_voice_log';
    var NOTICE_KEY = 'hci_voice_notice_v1';
    var SR = global.SpeechRecognition || global.webkitSpeechRecognition;

    var S = {
        cfg: null,
        rec: null,
        enabled: false,      // 用户是否已开启语音交互
        listening: false,
        speaking: false,
        ttsOn: true,
        denied: false,       // 麦克风权限被拒绝 / 不可用
        unsupported: false,  // 浏览器不支持语音识别
        failCount: 0,
        lastRaw: '',
        lastIntentId: '',
        lastIntentAt: 0,
        lockUntil: 0,
        restartTimer: null,
        speakTimer: null,
        els: {},
        log: []
    };

    /* ---------------------------------------------------------------- 工具 */

    function norm(text) {
        return String(text || '')
            .replace(/[\s\u3000]/g, '')
            .replace(/[，。！？、,.!?~～`"'“”‘’（）()【】\[\]·…—\-_:：；;]/g, '')
            .replace(/皮影戏|影子戏/g, '皮影')
            .replace(/抖空竹/g, '空竹')
            .replace(/捏泥人|泥人张/g, '泥人');
    }

    function now() { return Date.now(); }

    function fmtTime(ts) {
        var d = new Date(ts);
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    /* ---------------------------------------------------------- 识别日志 */

    function readLog() {
        try { return JSON.parse(global.localStorage.getItem(LOG_KEY) || '[]'); }
        catch (e) { return []; }
    }

    function writeLog(arr) {
        try { global.localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-300))); }
        catch (e) { /* 隐私模式或空间不足时静默失败 */ }
    }

    function addLog(raw, intentId, ok) {
        var arr = readLog();
        arr.push({ t: now(), hall: S.cfg ? S.cfg.hall : '', raw: raw, intent: intentId || '', ok: !!ok });
        writeLog(arr);
        S.log = arr;
    }

    function exportLog() {
        var arr = readLog();
        if (!arr.length) { alert('暂无识别记录。请先通过语音或模拟输入执行几条指令。'); return; }
        var lines = ['时间,展馆,识别文本,命中意图,是否成功'];
        arr.forEach(function (r) {
            lines.push([fmtTime(r.t), r.hall, '"' + (r.raw || '').replace(/"/g, '""') + '"',
                r.intent || '未命中', r.ok ? '成功' : '失败'].join(','));
        });
        var blob = new global.Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '语音识别日志_' + (S.cfg ? S.cfg.hall : '大厅') + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    /* ------------------------------------------------------------- 界面层 */

    var CSS = ''
        + '.vd-panel{position:fixed;right:18px;bottom:18px;width:318px;background:#fffdf8;'
        + 'border:1px solid #ddc8b0;border-radius:14px;box-shadow:0 6px 18px rgba(139,69,19,.18);'
        + 'font-family:"Microsoft YaHei",sans-serif;z-index:9999;padding:12px 14px;}'
        + '.vd-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;}'
        + '.vd-dot{width:9px;height:9px;border-radius:50%;background:#bfae99;flex:none;}'
        + '.vd-dot.listening{background:#2e9b57;box-shadow:0 0 0 0 rgba(46,155,87,.6);animation:vdPulse 1.2s infinite;}'
        + '.vd-dot.success{background:#2b6cb0;}'
        + '.vd-dot.fail{background:#c82423;}'
        + '.vd-dot.warn{background:#d98324;}'
        + '@keyframes vdPulse{0%{box-shadow:0 0 0 0 rgba(46,155,87,.55)}70%{box-shadow:0 0 0 8px rgba(46,155,87,0)}100%{box-shadow:0 0 0 0 rgba(46,155,87,0)}}'
        + '.vd-title{font-size:13px;color:#8b4513;font-weight:700;flex:1;}'
        + '.vd-mini{border:1px solid #ddc8b0;background:#fff;color:#8b4513;border-radius:50%;'
        + 'width:22px;height:22px;font-size:12px;cursor:pointer;line-height:1;}'
        + '.vd-main{display:flex;align-items:center;gap:10px;}'
        + '.vd-mic{width:52px;height:52px;border-radius:50%;border:2px solid #e6d2bb;background:#fff;'
        + 'font-size:22px;cursor:pointer;flex:none;transition:.2s;}'
        + '.vd-mic.on{background:#8b4513;border-color:#8b4513;}'
        + '.vd-right{flex:1;min-width:0;}'
        + '.vd-state{font-size:12.5px;color:#555;line-height:1.5;min-height:32px;}'
        + '.vd-wave{display:none;gap:3px;align-items:flex-end;height:16px;margin-top:2px;}'
        + '.vd-wave.on{display:flex;}'
        + '.vd-wave i{display:block;width:4px;background:#2e9b57;border-radius:2px;height:4px;'
        + 'animation:vdWave .9s infinite ease-in-out;}'
        + '.vd-wave i:nth-child(2){animation-delay:.12s}.vd-wave i:nth-child(3){animation-delay:.24s}'
        + '.vd-wave i:nth-child(4){animation-delay:.36s}.vd-wave i:nth-child(5){animation-delay:.48s}'
        + '@keyframes vdWave{0%,100%{height:4px}50%{height:15px}}'
        + '.vd-heard{margin-top:8px;font-size:13px;color:#8b4513;background:#f6ede0;'
        + 'border-radius:8px;padding:7px 9px;min-height:34px;line-height:1.5;}'
        + '.vd-heard.interim{color:#999;font-style:italic;}'
        + '.vd-tips{margin-top:8px;font-size:11.5px;color:#8b7a66;line-height:1.6;}'
        + '.vd-foot{display:flex;gap:8px;margin-top:9px;}'
        + '.vd-foot button{flex:1;font-size:11.5px;padding:5px 0;border:1px solid #ddc8b0;'
        + 'background:#fff;color:#8b4513;border-radius:6px;cursor:pointer;}'
        + '.vd-foot button:hover{background:#f7efe3;}'
        + '.vd-modal{position:fixed;inset:0;background:rgba(40,25,12,.45);display:none;'
        + 'align-items:center;justify-content:center;z-index:10000;}'
        + '.vd-modal.show{display:flex;}'
        + '.vd-box{width:min(620px,92vw);max-height:80vh;overflow:auto;background:#fffdf8;'
        + 'border-radius:14px;padding:18px 22px;font-family:"Microsoft YaHei",sans-serif;}'
        + '.vd-box h4{color:#8b4513;font-size:16px;margin:0 0 10px;}'
        + '.vd-box table{width:100%;border-collapse:collapse;font-size:12.5px;}'
        + '.vd-box th,.vd-box td{border:1px solid #e6d2bb;padding:6px 8px;text-align:left;color:#444;}'
        + '.vd-box th{background:#f2ece2;color:#6b4a2b;}'
        + '.vd-box .vd-note{margin-top:10px;font-size:12px;color:#8b7a66;line-height:1.7;}'
        + '.vd-box .vd-ok{margin-top:12px;text-align:right;}'
        + '.vd-box .vd-ok button{padding:6px 16px;border:none;background:#8b4513;color:#fff8e8;'
        + 'border-radius:8px;cursor:pointer;}';

    function injectCss() {
        var st = document.createElement('style');
        st.id = 'vd-style';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    function buildPanel() {
        var hall = S.cfg.hall || '大厅';
        var panel = document.createElement('div');
        panel.className = 'vd-panel';
        panel.id = 'vdPanel';
        panel.innerHTML = ''
            + '<div class="vd-head"><span class="vd-dot" id="vdDot"></span>'
            + '<span class="vd-title">语音助手 · ' + hall + '</span>'
            + '<button class="vd-mini" id="vdHelpBtn" title="查看全部语音指令">?</button></div>'
            + '<div class="vd-main">'
            + '<button class="vd-mic" id="vdMic" title="点击开启 / 关闭语音">🎤</button>'
            + '<div class="vd-right"><div class="vd-state" id="vdState">点击麦克风按钮开启语音交互</div>'
            + '<div class="vd-wave" id="vdWave"><i></i><i></i><i></i><i></i><i></i></div></div></div>'
            + '<div class="vd-heard" id="vdHeard">等待识别…</div>'
            + '<div class="vd-tips" id="vdTips">可以说：' + (S.cfg.tips || []).join(' / ') + '</div>'
            + '<div class="vd-foot"><button id="vdTts">语音播报：开</button>'
            + '<button id="vdLogBtn">导出识别日志</button></div>';
        document.body.appendChild(panel);

        var modal = document.createElement('div');
        modal.className = 'vd-modal';
        modal.id = 'vdModal';
        modal.innerHTML = '<div class="vd-box"><h4>「' + hall + '」可用语音指令</h4>'
            + '<table><thead><tr><th style="width:30%">指令意图</th>'
            + '<th style="width:44%">示例说法（同义表达）</th><th>作用</th></tr></thead>'
            + '<tbody id="vdHelpBody"></tbody></table>'
            + '<p class="vd-note">识别失败时系统会自动提示并重试；也可以点击右上角“?”重新打开本表。'
            + '麦克风不可用时，全部功能仍可通过按钮和鼠标完成。</p>'
            + '<div class="vd-ok"><button id="vdModalOk">知道了</button></div></div>';
        document.body.appendChild(modal);

        S.els = {
            panel: panel,
            dot: document.getElementById('vdDot'),
            state: document.getElementById('vdState'),
            heard: document.getElementById('vdHeard'),
            wave: document.getElementById('vdWave'),
            mic: document.getElementById('vdMic'),
            tts: document.getElementById('vdTts'),
            modal: modal,
            helpBody: document.getElementById('vdHelpBody')
        };

        var body = '';
        (S.cfg.intents || []).forEach(function (it) {
            body += '<tr><td>' + it.label + '<br><span style="color:#999;font-size:11px">'
                + (it.type || '') + '</span></td><td>'
                + (it.examples || []).map(function (e) { return '“' + e + '”'; }).join('、')
                + '</td><td>' + (it.desc || '') + '</td></tr>';
        });
        S.els.helpBody.innerHTML = body;

        S.els.mic.addEventListener('click', function () { toggle(); });
        document.getElementById('vdHelpBtn').addEventListener('click', openHelp);
        document.getElementById('vdModalOk').addEventListener('click', function () {
            modal.classList.remove('show');
        });
        S.els.tts.addEventListener('click', function () {
            S.ttsOn = !S.ttsOn;
            S.els.tts.textContent = '语音播报：' + (S.ttsOn ? '开' : '关');
            if (!S.ttsOn && global.speechSynthesis) { global.speechSynthesis.cancel(); S.speaking = false; }
        });
        document.getElementById('vdLogBtn').addEventListener('click', exportLog);
    }

    function setStatus(kind, text) {
        var d = S.els.dot, st = S.els.state, w = S.els.wave;
        if (!d) { return; }
        d.className = 'vd-dot' + (kind ? ' ' + kind : '');
        st.textContent = text;
        w.className = 'vd-wave' + (kind === 'listening' ? ' on' : '');
        S.els.mic.className = 'vd-mic' + (S.enabled ? ' on' : '');
    }

    function showHeard(text, interim) {
        if (!S.els.heard) { return; }
        S.els.heard.className = 'vd-heard' + (interim ? ' interim' : '');
        S.els.heard.textContent = text ? (interim ? '识别中：' + text : '听到：' + text) : '等待识别…';
    }

    function openHelp() {
        if (!S.els.modal) { return; }
        S.els.modal.classList.add('show');
    }

    /* ------------------------------------------------------------- 语音合成 */

    function speak(text, done) {
        if (!S.ttsOn || !global.speechSynthesis || !text) { if (done) { done(); } return; }
        try {
            global.speechSynthesis.cancel();
            var u = new global.SpeechSynthesisUtterance(text);
            u.lang = 'zh-CN';
            u.rate = 1.05;
            u.pitch = 1;
            S.speaking = true;
            var finished = false;
            var finish = function () {
                if (finished) { return; }
                finished = true;
                S.speaking = false;
                clearTimeout(S.speakTimer);
                if (done) { done(); }
            };
            u.onend = finish;
            u.onerror = finish;
            S.speakTimer = setTimeout(finish, 7000);
            global.speechSynthesis.speak(u);
        } catch (e) {
            S.speaking = false;
            if (done) { done(); }
        }
    }

    /* ----------------------------------------------------------- 指令匹配 */

    function matchIntent(text) {
        var n = norm(text);
        if (!n) { return null; }
        var best = null, bestLen = 0, bestIdx = 9999;
        (S.cfg.intents || []).forEach(function (it, idx) {
            (it.keywords || it.examples || []).forEach(function (kw) {
                var k = norm(kw);
                if (k && n.indexOf(k) !== -1) {
                    if (k.length > bestLen || (k.length === bestLen && idx < bestIdx)) {
                        best = it; bestLen = k.length; bestIdx = idx;
                    }
                }
            });
        });
        return best;
    }

    function execute(intent, raw) {
        if (now() - S.lastIntentAt < 1200 && S.lastIntentId === intent.id) { return; }
        S.lastIntentId = intent.id;
        S.lastIntentAt = now();
        S.lockUntil = now() + 1200;   // 多模态协同：语音执行后短暂锁定其他输入
        S.failCount = 0;
        addLog(raw, intent.id, true);
        showHeard(raw, false);
        setStatus('success', '已执行：' + intent.label);
        var reply = intent.reply || ('已为你执行' + intent.label);
        var ret;
        try { ret = intent.action ? intent.action(raw) : null; } catch (e) { ret = null; }
        if (typeof ret === 'string') { reply = ret; }
        speak(reply, function () { if (S.enabled) { restartSoon(250); } });
    }

    function onFinal(text) {
        var raw = String(text || '').trim();
        S.lastRaw = raw;
        var intent = matchIntent(raw);
        if (intent) { execute(intent, raw); return; }

        addLog(raw, '', false);
        S.failCount += 1;
        showHeard(raw, false);
        var tip = (S.cfg.tips || ['帮助'])[0];
        if (/帮助|怎么玩|能说什么/.test(norm(raw))) {   // 兼容未配置帮助意图的页面
            S.failCount = 0;
            setStatus('success', '已为你打开指令帮助');
            speak('已打开指令帮助', function () { openHelp(); if (S.enabled) { restartSoon(250); } });
            return;
        }
        setStatus('fail', '没听清或暂不支持，请再说一次');
        if (S.failCount >= 2) {
            showHeard('连续 2 次未匹配，已打开指令列表（可以说：' + tip + '）', false);
            speak('没听清，我先列一下能说的指令', function () {
                openHelp();
                if (S.enabled) { restartSoon(400); }
            });
            S.failCount = 0;
        } else {
            showHeard('没听清或暂不支持。可以说：' + (S.cfg.tips || []).join(' / '), false);
            speak('没听清，请再说一次', function () { if (S.enabled) { restartSoon(300); } });
        }
    }

    /* --------------------------------------------------------------- 识别 */

    function restartSoon(ms) {
        clearTimeout(S.restartTimer);
        S.restartTimer = setTimeout(function () {
            if (S.enabled && !S.listening) { startRec(); }
        }, ms || 300);
    }

    function startRec() {
        if (!S.rec || S.denied) { return; }
        if (S.speaking) { restartSoon(400); return; }
        try { S.rec.start(); S.listening = true; } catch (e) { /* 已在运行 */ }
    }

    function buildRec() {
        var rec = new SR();
        rec.lang = 'zh-CN';
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 3;

        rec.onstart = function () {
            S.listening = true;
            setStatus('listening', '正在聆听…请说指令（说完停顿一下）');
        };
        rec.onresult = function (ev) {
            var interim = '', finalText = '';
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var r = ev.results[i];
                if (r.isFinal) { finalText += r[0].transcript; } else { interim += r[0].transcript; }
            }
            if (interim) { showHeard(interim, true); }
            if (finalText) { onFinal(finalText); }
        };
        rec.onerror = function (ev) {
            var code = ev.error || '';
            if (code === 'no-speech') {
                setStatus('warn', '没有听到声音，请靠近麦克风再说一次');
                addLog('（未检测到语音）', '', false);
                restartSoon(500);
            } else if (code === 'not-allowed' || code === 'service-not-allowed') {
                S.denied = true;
                S.enabled = false;
                S.listening = false;
                setStatus('fail', '麦克风未授权：请在浏览器地址栏左侧允许麦克风后重试');
                showHeard('麦克风未授权。替代方案：直接使用面板按钮或鼠标完成全部体验。', false);
                S.els.mic.className = 'vd-mic';
            } else if (code === 'audio-capture') {
                setStatus('fail', '未检测到麦克风设备，请检查设备后重试');
                S.listening = false;
            } else if (code === 'network') {
                setStatus('fail', '语音识别服务连接失败，请检查网络（Chrome 语音识别需要联网）');
                S.listening = false;
            } else if (code === 'aborted') {
                S.listening = false;
            } else {
                setStatus('warn', '识别异常（' + code + '），已尝试恢复');
                restartSoon(600);
            }
        };
        rec.onend = function () {
            S.listening = false;
            if (S.enabled && !S.denied) { restartSoon(S.speaking ? 500 : 300); }
        };
        return rec;
    }

    /* ------------------------------------------------------------ 对外接口 */

    function toggle() {
        if (S.unsupported) {
            setStatus('fail', '当前浏览器不支持语音识别（请使用 Chrome 浏览器）');
            showHeard('语音不可用：点击面板按钮或使用鼠标即可完成全部体验。', false);
            return;
        }
        if (!S.enabled) { start(); } else { stop(); }
    }

    function start() {
        if (S.denied) {
            setStatus('fail', '麦克风未授权，请先允许权限；或直接使用按钮/鼠标');
            return;
        }
        S.enabled = true;
        showNoticeIfNeeded();
        if (global.speechSynthesis) { global.speechSynthesis.cancel(); S.speaking = false; }
        setStatus('listening', '正在开启语音监听…');
        startRec();
        speak('语音已开启，可以说' + (S.cfg.tips || ['帮助'])[0]);
    }

    function stop() {
        S.enabled = false;
        S.listening = false;
        clearTimeout(S.restartTimer);
        try { if (S.rec) { S.rec.stop(); } } catch (e) { }
        if (global.speechSynthesis) { global.speechSynthesis.cancel(); S.speaking = false; }
        setStatus('', '语音已关闭，点击麦克风重新开启');
        showHeard('', false);
    }

    function showNoticeIfNeeded() {
        try {
            if (global.localStorage.getItem(NOTICE_KEY)) { return; }
            global.localStorage.setItem(NOTICE_KEY, '1');
        } catch (e) { return; }
        addLog('（已提示隐私说明）', '', true);
        var box = document.createElement('div');
        box.className = 'vd-modal show';
        box.innerHTML = '<div class="vd-box"><h4>麦克风与隐私说明</h4>'
            + '<p style="font-size:13px;line-height:1.8;color:#444">'
            + '1. 语音识别仅用于本页面的指令触发，不录音、不保存音频、不上传至本项目服务器；'
            + '浏览器自带的语音识别服务可能将音频发往浏览器厂商的语音服务，具体以浏览器隐私说明为准。<br>'
            + '2. 识别出的文字仅临时显示在页面，不写入任何远端系统。<br>'
            + '3. 拒绝授权不影响使用：所有功能都可以用鼠标和面板按钮完成。'
            + '</p><div class="vd-ok"><button id="vdNoticeOk">我知道了</button></div></div>';
        document.body.appendChild(box);
        box.querySelector('#vdNoticeOk').addEventListener('click', function () {
            box.parentNode.removeChild(box);
        });
    }

    /**
     * 文字模拟输入：便于无麦克风环境演示与用户测试统一触发。
     * 例如 HciVoice.simulate('换红色')
     */
    function simulate(text) {
        if (!text) { return; }
        showHeard(text, false);
        onFinal(text);
    }

    function init(cfg) {
        S.cfg = cfg || {};
        S.cfg.intents = S.cfg.intents || [];
        S.cfg.tips = S.cfg.tips || [];
        S.cfg.hall = S.cfg.hall || '展馆';

        injectCss();
        buildPanel();
        setStatus('', '点击麦克风按钮开启语音交互');

        if (!SR) {
            S.unsupported = true;
            setStatus('warn', '当前浏览器不支持语音识别，请使用 Chrome；可用按钮/鼠标完成体验');
        } else {
            S.rec = buildRec();
        }

        // 页面卸载时释放麦克风与语音
        global.addEventListener('beforeunload', function () {
            try { if (S.rec) { S.rec.abort(); } } catch (e) { }
            if (global.speechSynthesis) { global.speechSynthesis.cancel(); }
        });

        return {
            start: start, stop: stop, toggle: toggle, simulate: simulate,
            openHelp: openHelp, log: readLog, exportLog: exportLog
        };
    }

    global.HciVoice = {
        init: init,
        simulate: simulate,
        start: start,
        stop: stop,
        toggle: toggle,
        openHelp: openHelp,
        exportLog: exportLog,
        // 多模态协同：其他输入源（鼠标/手势）可先询问是否处于语音锁定窗口
        isLocked: function () { return now() < S.lockUntil; },
        lastCommandAt: function () { return S.lastIntentAt; },
        // 用户测试统计：识别次数与成功率（按本次运行/本次浏览器累计）
        stats: function () {
            var arr = readLog().filter(function (r) { return r.intent !== '（已提示隐私说明）'; });
            var total = arr.filter(function (r) { return r.raw && r.raw.indexOf('（未检测到语音）') === -1; }).length;
            var ok = arr.filter(function (r) { return r.ok && r.raw && r.raw.indexOf('（未检测到语音）') === -1; }).length;
            return { total: total, success: ok, rate: total ? +(ok / total * 100).toFixed(1) : 0 };
        },
        _state: S
    };
})(window);
