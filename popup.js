const API_KEY = 'tGapO2EC6HoiPjLejRvLSVhFL11DOZ2Z'; 
const runAiButton = document.getElementById('runAiButton');
const debugViewer = document.getElementById('analysisResult');
const promptInput = document.getElementById('promptInput');
const status = document.getElementById('status');

async function callMistral(messages, temp = 0.4) {
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

runAiButton.addEventListener('click', async () => {
    status.textContent = 'Đang thu thập dữ liệu...';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Thu thập dữ liệu, lọc honeypot/phần tử ẩn và gán ID
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

    // Lượt 1: Lọc & Lập kế hoạch
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

    // Lượt 2: Ra quyết định (Sử dụng ID)
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
            LƯU Ý: Việc click vào text box để nhập là không cần thiết vì hệ thống có thể tự điền vào mà không cần thao tác click như người dùng bình thường. Đọc kỹ các nội dung trên màn hình liên quan đến yêu cầu của người dùng nếu cần.`
        },
        { 
            role: "user", 
            content: `Yêu cầu: ${promptInput.value}. Kế hoạch: ${plan}. 
            Danh sách phần tử tương tác: 
            ${pageData[0].result.elementsList}
            
            Hãy thực hiện hành động dựa trên dữ liệu trang thực tế.` 
        }
    ], 0.4);

    // Parse JSON an toàn
    const result = JSON.parse(actionJson.match(/\{[\s\S]*\}/)[0]);
    debugViewer.textContent = JSON.stringify(result, null, 2);
    status.textContent = 'Đang thực thi: ' + result.action;

    // Thực thi trên trang dựa trên ID đã gán
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
                    el.value = res.value;
                    
                    const events = ['input', 'change', 'blur'];
                    events.forEach(eventType => {
                        el.dispatchEvent(new Event(eventType, { 
                            bubbles: true, 
                            cancelable: true 
                        }));
                    });
                    
                    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                }
            }
        }
    });
    status.textContent = 'Đã hoàn tất!';
});