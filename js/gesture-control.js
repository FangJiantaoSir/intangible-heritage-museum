(function (global) {
    'use strict';

    var session = null;

    function countExtendedFingers(points) {
        var count = 0;
        // Ignore the thumb because its direction varies with camera angle.
        [[8, 6], [12, 10], [16, 14], [20, 18]].forEach(function (pair) {
            if (points[pair[0]].y < points[pair[1]].y - 0.025) { count += 1; }
        });
        return count;
    }

    function start(options) {
        options = options || {};
        if (session) { stop(); }
        if (!global.Hands || !global.Camera) {
            options.onStatus('手势识别组件加载失败，请检查网络后刷新页面');
            return Promise.resolve(false);
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            options.onStatus('当前浏览器无法访问摄像头，请使用 localhost 下的最新版 Chrome');
            return Promise.resolve(false);
        }

        var video = options.video;
        var active = true;
        var hands = new global.Hands({ locateFile: function (file) {
            return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file;
        } });
        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.6,
            minTrackingConfidence: 0.55
        });
        hands.onResults(function (results) {
            if (!active) { return; }
            var points = results.multiHandLandmarks && results.multiHandLandmarks[0];
            if (!points) {
                options.onStatus('未检测到手掌，请将手放入画面');
                return;
            }
            var extended = countExtendedFingers(points);
            var gesture = {
                x: 1 - points[9].x,
                y: points[9].y,
                open: extended >= 3,
                fist: extended <= 1,
                fingers: extended
            };
            options.onGesture(gesture);
            options.onStatus(gesture.open ? '已识别张开手掌：移动手掌进行控制' :
                (gesture.fist ? '已识别握拳：控制已暂停' : '手势已识别：张开手掌以控制'));
        });

        try {
            var camera = new global.Camera(video, {
                onFrame: async function () {
                    if (active) { await hands.send({ image: video }); }
                },
                width: 640,
                height: 480
            });
            session = { camera: camera, hands: hands, video: video, stop: function () {
                active = false;
                camera.stop();
                hands.close();
                if (video.srcObject) {
                    video.srcObject.getTracks().forEach(function (track) { track.stop(); });
                    video.srcObject = null;
                }
            } };
            return camera.start().then(function () {
                if (active) { options.onStatus('摄像头已开启，请将手掌放入画面'); }
                return active;
            }).catch(function (error) {
                active = false;
                try { camera.stop(); } catch (ignore) {}
                try { hands.close(); } catch (ignore) {}
                if (session && session.video === video) { session = null; }
                options.onStatus(error && error.name === 'NotAllowedError' ?
                    '摄像头权限未开启，请在浏览器地址栏允许摄像头' : '摄像头启动失败，请检查设备或使用鼠标操作');
                return false;
            });
        } catch (error) {
            try { hands.close(); } catch (ignore) {}
            options.onStatus('摄像头启动失败，请检查设备或使用鼠标操作');
            return Promise.resolve(false);
        }
    }

    function stop() {
        if (!session) { return; }
        var current = session;
        session = null;
        try { current.stop(); } catch (ignore) {}
    }

    global.HciGesture = { start: start, stop: stop, isActive: function () { return !!session; } };
})(window);
