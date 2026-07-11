const API_KEY = 'YOUR-API-KEY'; 
const runAiButton = document.getElementById('runAiButton');
const analyzeLayoutButton = document.getElementById('analyzeLayoutButton');
const debugViewer = document.getElementById('analysisResult');
const promptInput = document.getElementById('promptInput');
const status = document.getElementById('status');

async function callMistral(messages, temp = 0.3) {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${API_KEY}` 
        },
        body: JSON.stringify({ 
            model: 'mistral-small-latest', 
            messages, 
            temperature: temp 
        })
    });
    const data = await res.json();
    return data.choices[0].message.content;
}

// Tính năng 1: Chống kiểm tra Fullscreen (Đã nâng cấp ẩn Descriptor & Sai số kích thước tự nhiên)
analyzeLayoutButton.addEventListener('click', async () => {
    status.textContent = 'Đang quét biến và khóa cơ chế Fullscreen...';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
        status.textContent = 'Không tìm thấy Tab hoạt động!';
        return;
    }

    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN', 
        func: () => {
            console.log("%c[Anti-Fullscreen] Kích hoạt chế độ tàng hình nâng cao...", "color: #10b981; font-weight: bold;");

            const detectedProps = new Set();
            const logDetection = (prop) => {
                if (!detectedProps.has(prop)) {
                    detectedProps.add(prop);
                    console.log(`%c[Bắt bài] Hệ thống vừa check: ${prop}`, "color: #f59e0b; font-weight: bold;");
                }
            };

            const fullscreenProperties = {
                document: ['fullscreenElement', 'fullscreenEnabled'],
                window: ['innerHeight', 'innerWidth', 'outerHeight', 'outerWidth'],
                screen: ['width', 'height', 'availWidth', 'availHeight']
            };

            const legacyFullscreenProperties = {
                document: ['webkitFullscreenElement', 'mozFullScreenElement', 'msFullscreenElement', 'webkitFullscreenEnabled', 'mozFullScreenEnabled', 'msFullScreenEnabled', 'webkitIsFullScreen', 'mozFullScreen']
            };

            const fullscreenTarget = document.body || document.documentElement;
            const fullscreenSize = {
                width: Math.max(window.screen.width || window.innerWidth || 1920, 1920),
                height: Math.max(window.screen.height || window.innerHeight || 1080, 1080)
            };

            const defineReadOnly = (obj, prop, getter) => {
                try {
                    Object.defineProperty(obj, prop, {
                        get: getter,
                        set: () => true,
                        enumerable: true,
                        configurable: false
                    });
                } catch (e) {}
            };

            // 1. Giả lập trạng thái fullscreen hợp lệ
            fullscreenProperties.document.forEach(prop => {
                defineReadOnly(document, prop, function() {
                    logDetection(`document.${prop}`);
                    return prop === 'fullscreenElement' ? fullscreenTarget : true;
                });
            });

            legacyFullscreenProperties.document.forEach(prop => {
                if (prop in document) {
                    defineReadOnly(document, prop, function() {
                        logDetection(`document.${prop}`);
                        const isElementProp = /element/i.test(prop);
                        return isElementProp ? fullscreenTarget : true;
                    });
                }
            });

            // 2. Giả lập kích thước và tỷ lệ giống fullscreen
            fullscreenProperties.window.forEach(prop => {
                try {
                    defineReadOnly(window, prop, function() {
                        logDetection(`window.${prop}`);
                        return prop.toLowerCase().includes('width') ? fullscreenSize.width : fullscreenSize.height;
                    });
                } catch (e) {}
            });

            fullscreenProperties.screen.forEach(prop => {
                try {
                    defineReadOnly(window.screen, prop, function() {
                        logDetection(`screen.${prop}`);
                        return prop.toLowerCase().includes('width') ? fullscreenSize.width : fullscreenSize.height;
                    });
                } catch (e) {}
            });

            // 3. Giữ trạng thái hiển thị như đang ở foreground
            try {
                Object.defineProperty(document, 'visibilityState', { get: () => 'visible', enumerable: true, configurable: false });
                Object.defineProperty(document, 'hidden', { get: () => false, enumerable: true, configurable: false });
                Object.defineProperty(document, 'hasFocus', { get: () => true, enumerable: true, configurable: false });
            } catch (e) {}

            // 4. Giả lập API fullscreen và phát sự kiện phù hợp
            const makeNativeFake = (value, fallback) => value ?? fallback;
            const originalAddEventListener = EventTarget.prototype.addEventListener;
            const blockedEvents = ['blur'];

            EventTarget.prototype.addEventListener = function(type, listener, options) {
                const eventType = String(type).toLowerCase();
                if (['fullscreenchange', 'fullscreenerror', 'webkitfullscreenchange', 'mozfullscreenchange', 'msfullscreenchange'].includes(eventType)) {
                    logDetection(`EventTarget.${eventType}`);
                    return makeNativeFake(originalAddEventListener.call(this, eventType, listener, options), undefined);
                }
                if (blockedEvents.includes(eventType)) {
                    logDetection(`EventTarget.${eventType}`);
                    return makeNativeFake(originalAddEventListener.call(this, eventType, function(e) {
                        e.stopImmediatePropagation();
                    }, options), undefined);
                }
                return makeNativeFake(originalAddEventListener.call(this, type, listener, options), undefined);
            };

            const patchFullscreenMethod = (target, methodName) => {
                if (!target || !target[methodName]) return;
                try {
                    Object.defineProperty(target, methodName, {
                        configurable: false,
                        writable: false,
                        value: function() {
                            logDetection(`API.${methodName}`);
                            try {
                                document.dispatchEvent(new Event('fullscreenchange'));
                                window.dispatchEvent(new Event('fullscreenchange'));
                                window.dispatchEvent(new Event('resize'));
                            } catch (e) {}
                            return Promise.resolve(this);
                        }
                    });
                } catch (e) {}
            };

            patchFullscreenMethod(HTMLElement.prototype, 'requestFullscreen');
            patchFullscreenMethod(Document.prototype, 'exitFullscreen');
            patchFullscreenMethod(HTMLElement.prototype, 'webkitRequestFullscreen');
            patchFullscreenMethod(Document.prototype, 'webkitExitFullscreen');
            patchFullscreenMethod(HTMLElement.prototype, 'mozRequestFullScreen');
            patchFullscreenMethod(Document.prototype, 'mozCancelFullScreen');
            patchFullscreenMethod(HTMLElement.prototype, 'msRequestFullscreen');
            patchFullscreenMethod(Document.prototype, 'msExitFullscreen');

            const originalMatchMedia = window.matchMedia;
            window.matchMedia = function(query) {
                if (/fullscreen|display-mode/i.test(query || '')) {
                    logDetection(`matchMedia(${query})`);
                    return makeNativeFake({
                        matches: true,
                        media: query,
                        onchange: null,
                        addListener() {},
                        removeListener() {},
                        addEventListener() {},
                        removeEventListener() {},
                        dispatchEvent() { return true; }
                    }, { matches: false, media: query });
                }
                return makeNativeFake(originalMatchMedia ? originalMatchMedia(query) : { matches: false, media: query }, { matches: false, media: query });
            };

            if (window.visualViewport) {
                ['width', 'height', 'offsetTop', 'offsetLeft'].forEach(prop => {
                    defineReadOnly(window.visualViewport, prop, function() {
                        logDetection(`visualViewport.${prop}`);
                        return prop.includes('width') ? fullscreenSize.width : fullscreenSize.height;
                    });
                });
            }

            window.dispatchEvent(new Event('resize'));
            document.dispatchEvent(new Event('fullscreenchange'));
            window.dispatchEvent(new Event('fullscreenchange'));
            window.dispatchEvent(new Event('focus'));
        }
    });

    status.textContent = 'Đã vô hiệu hóa check Fullscreen!';
});

// Tính năng 2: Thực thi AI (Đã tích hợp nativeInputValueSetter cho React/Vue/Angular)
runAiButton.addEventListener('click', async () => {
    status.textContent = 'Đang thu thập dữ liệu...';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    const pageData = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
            const allElements = document.querySelectorAll('button, [role="button"], a, input, textarea');
            
            const isVisible = (el) => {
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0 || rect.top < 0 || rect.left < 0) return false;
                return true;
            };

            const elements = Array.from(allElements).filter(el => isVisible(el));
            
            const formattedElements = elements.map((el, index) => {
                el.setAttribute('data-agent-id', index);
                const rect = el.getBoundingClientRect();
                const pos = `[x:${Math.round(rect.left)}, y:${Math.round(rect.top)}]`;
                
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    return `ID:${index} | Text:${el.placeholder || el.value || 'Trống'} | Pos:${pos}`;
                } else {
                    return `ID:${index} | Text:${el.innerText.trim() || 'Nút'} | Pos:${pos}`;
                }
            });

            return {
                text: document.body.innerText.substring(0, 3000),
                elementsList: formattedElements.join('\n')
            };
        }
    });

    status.textContent = 'Lượt 1: Đang lọc & lập kế hoạch...';
    const plan = await callMistral([
        { 
            role: "system", 
            content: "Bạn là chuyên gia trình duyệt. Loại bỏ nội dung thừa, chỉ giữ lại thông tin cần thiết để giải quyết yêu cầu. Tuyệt đối không tự ý sửa sai sót từ ngữ của trang web." 
        },
        { 
            role: "user", 
            content: `Yêu cầu: ${promptInput.value}. Dữ liệu trang: ${pageData[0].result.text}` 
        }
    ], 0.4);

    status.textContent = 'Lượt 2: Đang ra quyết định...';
    const actionJson = await callMistral([
        { 
            role: "system", 
            content: `Bạn là bộ thực thi. 
            1. Dựa vào dữ liệu từ bước trước.
            2. Nếu cần click, 'target' PHẢI là ID chính xác của nút (ID thực tế được gán).
            3. TUYỆT ĐỐI KHÔNG LẤY từ khóa từ phần "Kế hoạch" làm target. 
            4. Chỉ trả về JSON duy nhất: {"action": "click" | "type", "id": number, "value": string (nếu là type), "reason": "..."}. Dựa vào ID đã được định dạng.
            Hành động cho phép: [click, type],
            LƯU Ý: Việc click vào text box để nhập là không cần thiết vì hệ thống có thể tự điền vào mà không cần thao tác click như người dùng bình thường. Đọc kỹ các nội dung trên màn hình liên quan đến yêu cầu của người dùng nếu cần. BẮT BUỘC phải sử dụng đúng hành động cho từng loại phần tử(nút thì click, ô nhập thì type). Hành động đúng theo yêu cầu của người dùng. TUYỆT ĐỐI không được làm sai hoặc tự nghĩ ra thứ khác để nhập. CÓ THỂ dựa trên vị trí đính kèm để hình dung được cấu trúc trình duyệt và trả về kết quả chính xác hơn."}`
        },
        { 
            role: "user", 
            content: `Yêu cầu: ${promptInput.value}. Kế hoạch: ${plan}. 
            Danh sách phần tử tương tác: 
            ${pageData[0].result.elementsList}
            
            Hãy thực hiện hành động dựa trên dữ liệu trang thực tế.` 
        }
    ], 0.4);

    const result = JSON.parse(actionJson.match(/\{[\s\S]*\}/)[0]);
    debugViewer.textContent = JSON.stringify(result, null, 2);
    status.textContent = 'Đang thực thi: ' + result.action;

    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [result],
        func: (res) => {
            const el = document.querySelector(`[data-agent-id="${res.id}"]`);
            if (el) {
                if (res.action === 'click') {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.click();
                } else if (res.action === 'type') {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.focus();

                    // BẢN VÁ NÂNG CAO: Buộc các JS Framework (React, Vue, Angular) phải cập nhật nội bộ State
                    try {
                        const prototype = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(prototype, "value").set;
                        nativeInputValueSetter.call(el, res.value);
                    } catch(e) {
                        // Dự phòng fallback nếu trang web không dùng các framework phức tạp
                        el.value = res.value; 
                    }
                    
                    // Phát chuỗi sự kiện chuẩn hóa mô phỏng hành vi gõ bàn phím thật
                    const events = ['input', 'change', 'blur'];
                    events.forEach(eventType => {
                        el.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
                    });
                    
                    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                }
            }
        }
    });
    status.textContent = 'Đã hoàn tất!';
});
