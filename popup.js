const GEMINI_API_KEY = 'AIzaSyDYwHDf1r5DySKhq4NtX8K1HKROJUqOm_Y';
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const runAiButton = document.getElementById('runAiButton');
const analyzeLayoutButton = document.getElementById('analyzeLayoutButton');
const debugViewer = document.getElementById('analysisResult');
const promptInput = document.getElementById('promptInput');
const status = document.getElementById('status');
const wasmModuleUrl = chrome.runtime.getURL('logic.wasm');

function buildGeminiPayload(messages, temp = 0.1) {
    const contents = [];
    let systemInstruction = '';

    messages.forEach((message) => {
        if (message.role === 'system') {
            systemInstruction += `${message.content}\n`;
            return;
        }

        contents.push({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }]
        });
    });

    const payload = {
        contents,
        generationConfig: {
            temperature: temp,
            maxOutputTokens: 4096
        }
    };

    if (systemInstruction.trim()) {
        payload.systemInstruction = {
            parts: [{ text: systemInstruction.trim() }]
        };
    }

    return payload;
}

async function sendGeminiRequestViaPage(body) {
    const response = await fetch(wasmModuleUrl);
    const buffer = await response.arrayBuffer();
    let wasmMemory;
    const imports = {
        env: {
            send_request: (bodyPtr, bodyLen, respPtr, respMaxLen) => {
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();
                const bodyText = decoder.decode(new Uint8Array(wasmMemory.buffer, bodyPtr, bodyLen));
                const xhr = new XMLHttpRequest();
                xhr.open('POST', GEMINI_ENDPOINT, false);
                xhr.setRequestHeader('Content-Type', 'application/json');
                let responseText = '';
                try {
                    xhr.send(bodyText);
                    responseText = xhr.responseText || '';
                } catch (e) {
                    responseText = JSON.stringify({
                        __wasm_error: true,
                        message: 'XHR send failed',
                        error: e?.message || String(e)
                    });
                }
                if (xhr.status !== 200 || !responseText.trim()) {
                    const errorPayload = JSON.stringify({
                        __wasm_error: true,
                        status: xhr.status,
                        statusText: xhr.statusText,
                        responseText: responseText || '',
                        message: xhr.status === 0 ? 'CORS or network failure likely' : 'Non-200 HTTP response or empty body'
                    });
                    const encodedError = encoder.encode(errorPayload);
                    const errorLen = Math.min(encodedError.length, respMaxLen);
                    new Uint8Array(wasmMemory.buffer, respPtr, errorLen).set(encodedError.subarray(0, errorLen));
                    return errorLen;
                }
                const encoded = encoder.encode(responseText);
                const length = Math.min(encoded.length, respMaxLen);
                new Uint8Array(wasmMemory.buffer, respPtr, length).set(encoded.subarray(0, length));
                return length;
            }
        }
    };

    const { instance } = await WebAssembly.instantiate(buffer, imports);
    wasmMemory = instance.exports.memory;
    const wasm = instance.exports;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bodyBytes = encoder.encode(body);
    const bodyPtr = wasm.malloc(bodyBytes.length);
    new Uint8Array(wasmMemory.buffer, bodyPtr, bodyBytes.length).set(bodyBytes);
    const respLen = 65536;
    const respPtr = wasm.malloc(respLen);
    const sendRequestFn = wasm.send_groq_request || wasm.send_mistral_request || wasm.send_ai_request || wasm.send_request;
    if (typeof sendRequestFn !== 'function') {
        const availableExports = Object.keys(wasm).join(', ');
        throw new Error(`WASM export not found: expected send_groq_request, send_mistral_request, send_ai_request, or send_request. Available exports: ${availableExports}`);
    }
    const actualLen = sendRequestFn(bodyPtr, bodyBytes.length, respPtr, respLen);
    if (actualLen <= 0) {
        throw new Error('WASM request failed');
    }
    const resultText = decoder.decode(new Uint8Array(wasmMemory.buffer, respPtr, actualLen));
    if (!resultText || !resultText.trim()) {
        throw new Error(`WASM returned empty response text. body length=${bodyBytes.length}, actualLen=${actualLen}, respMaxLen=${respLen}`);
    }
    try {
        const maybeError = JSON.parse(resultText);
        if (maybeError?.__wasm_error) {
            throw new Error(`WASM transport error: ${maybeError.message || 'Unknown'} (${maybeError.status || 0} ${maybeError.statusText || ''}) responseText=${maybeError.responseText || ''}`);
        }
    } catch (err) {
        if (err instanceof SyntaxError) {
            // Not a JSON error payload; continue returning raw response text.
        } else {
            throw err;
        }
    }
    return resultText;
}

async function callGemini(messages, temp = 0.1) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
        throw new Error('No active tab found');
    }
    const body = JSON.stringify(buildGeminiPayload(messages, temp));
    const responseText = await sendGeminiRequestViaPage(body);
    if (!responseText || !responseText.trim()) {
        throw new Error('Gemini API trả về response rỗng');
    }
    let response;
    try {
        response = JSON.parse(responseText);
    } catch (error) {
        throw new Error(`Gemini API trả về JSON không hợp lệ: ${error.message}. Raw response: ${responseText}`);
    }
    return response.candidates?.[0]?.content?.parts?.[0]?.text
        || response.text
        || '';
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
                args: [wasmModuleUrl],
                func: async (wasmUrl) => {
                    const response = await fetch(wasmUrl);
                    const buffer = await response.arrayBuffer();
                    const imports = {
                        env: {
                            send_request: () => 0
                        }
                    };
                    const { instance } = await WebAssembly.instantiate(buffer, imports);
                    const wasm = instance.exports;
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
            const pageWindowWidth = window.innerWidth || 1920;
            const pageScreenWidth = window.screen.width || 1920;
            const pageWindowHeight = window.innerHeight || 1080;
            const pageScreenHeight = window.screen.height || 1080;
            const fullscreenSize = {
                width: wasm.clamp_dimension(1, pageWindowWidth, pageScreenWidth),
                height: wasm.clamp_dimension(0, pageWindowHeight, pageScreenHeight)
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
        args: [wasmModuleUrl],
        func: async (wasmUrl) => {
            try {
                const response = await fetch(wasmUrl);
                const buffer = await response.arrayBuffer();
                const imports = {
                    env: {
                        send_request: () => 0
                    }
                };
                const { instance } = await WebAssembly.instantiate(buffer, imports);
                const wasm = instance.exports;

                const allElements = Array.from(document.querySelectorAll('*')).filter((el) => {
                    if (!el || !el.tagName || !el.isConnected) return false;
                    const tagName = el.tagName.toLowerCase();
                    return !['script', 'style', 'noscript', 'meta', 'link', 'svg', 'path', 'img'].includes(tagName);
                });
                
                const isVisible = (el) => {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0 || rect.top < 0 || rect.left < 0) return false;
                    return wasm.is_visible_rect(
                        Math.round(rect.width),
                        Math.round(rect.height),
                        Math.round(rect.top),
                        Math.round(rect.left)
                    ) === 1;
                };

                const visibleElements = allElements.filter(el => isVisible(el));
                
                const formattedElements = visibleElements.map((el, index) => {
                    el.setAttribute('data-agent-id', index);
                    const rect = el.getBoundingClientRect();
                    const pos = `[x:${Math.round(rect.left)}, y:${Math.round(rect.top)}, w:${Math.round(rect.width)}, h:${Math.round(rect.height)}]`;
                    const rawText = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
                        ? (el.placeholder || el.value || 'Trống')
                        : (el.innerText?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '');
                    const text = rawText || el.tagName.toLowerCase();
                    const role = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
                        ? 'input'
                        : (el.tagName === 'A' ? 'link' : (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ? 'button' : 'non-interactive'));
                    const elementType = el.tagName === 'INPUT'
                        ? `input(${el.type || 'text'})`
                        : el.tagName === 'TEXTAREA'
                            ? 'textarea'
                            : el.tagName === 'A'
                                ? 'a'
                                : el.tagName === 'BUTTON'
                                    ? 'button'
                                    : el.getAttribute('role') === 'button'
                                        ? 'button'
                                        : el.tagName.toLowerCase();
                    return `ID:${index} | Role:${role} | Type:${elementType} | Text:${text} | Pos:${pos}`;
                });

                return {
                    url: window.location.href,
                    title: document.title || '',
                    visibleElements: formattedElements,
                    elementsList: formattedElements.join('\n')
                };
            } catch (error) {
                return {
                    url: window.location.href,
                    title: document.title || '',
                    visibleElements: [],
                    elementsList: ''
                };
            }
        }
    });

    const scriptResult = pageData?.[0]?.result;
    if (!scriptResult) {
        status.textContent = 'Lỗi: không thể thu thập dữ liệu trang. Vui lòng thử lại.';
        return;
    }

    status.textContent = 'Đang ra quyết định...';
    const actionJson = await callGemini([
        {
            role: "system",
            content: `Bạn là bộ thực thi trình duyệt thông minh. Dựa vào dữ liệu trang thực tế và yêu cầu của người dùng để chọn đúng hành động. Chỉ trả về JSON duy nhất theo mẫu: {"action": "click" | "type", "id": number, "value": string (nếu là type), "reason": "..."}. Nếu là nút thì chọn click; nếu là ô nhập thì chọn type. Việc click vào ô nhập để nhập là không cần thiết vì hệ thống có thể tự điền vào mà không cần thao tác click như người dùng bình thường. Khi chọn id, hãy dùng đúng ID thực tế được gán trong danh sách phần tử tương tác. Tuyệt đối không suy đoán hoặc tự tạo id khác. Nếu không chắc chắn, hãy ưu tiên phần tử có nhãn, placeholder, văn bản hoặc vị trí phù hợp nhất với yêu cầu. Luôn đọc kỹ các nội dung trên màn hình liên quan đến yêu cầu của người dùng. Không được làm sai loại hành động hoặc nhập giá trị không liên quan. 1 số thông tin trên trang có thể cung thêm thông tin hữu ích, hãy đọc kỹ và phân tích để đưa ra quyết định chính xác. Nếu không tìm thấy phần tử phù hợp, hãy trả về {"action": "none", "id": -1, "value": "", "reason": "Không tìm thấy phần tử phù hợp."}.`
        },
        {
            role: "user",
            content: `Yêu cầu: ${promptInput.value}. 
            Danh sách phần tử tương tác: 
            ${scriptResult.elementsList || ''}
            
            Hãy thực hiện hành động dựa trên dữ liệu trang thực tế.`
        }
    ], 0.6);

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