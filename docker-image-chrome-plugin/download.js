// download.js
// 负责从IndexedDB读取Blob并触发下载

async function init() {
    const params = new URLSearchParams(window.location.search);
    const key = params.get('key');
    const filename = params.get('filename');

    if (!key || !filename) {
        document.body.innerHTML = 'Error: Missing parameters';
        return;
    }

    try {
        const blob = await getBlobFromDB(key);
        if (!blob) {
            document.body.innerHTML = 'Error: Blob not found or expired';
            return;
        }

        const url = URL.createObjectURL(blob);

        // 使用chrome.downloads API (因为它在extension pages中可用)
        // 或者直接 a href. 优先使用 chrome.downloads 以保持一致的行为 (saveAs)
        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        }, (id) => {
            if (chrome.runtime.lastError || !id) {
                document.body.innerHTML = `Error: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download start failed'}`;
                return;
            }

            // 只有在下载完成或失败后才清理，避免用户还没确认保存对话框时就撤销 Blob URL。
            const listener = (delta) => {
                if (delta.id !== id || !delta.state) return;

                const state = delta.state.current;
                if (state !== 'complete' && state !== 'interrupted') return;

                chrome.downloads.onChanged.removeListener(listener);
                URL.revokeObjectURL(url);
                deleteBlobFromDB(key);

                if (state === 'complete') {
                    window.close();
                } else {
                    document.body.innerHTML = 'Error: Download interrupted';
                }
            };

            chrome.downloads.onChanged.addListener(listener);
        });

    } catch (err) {
        console.error(err);
        document.body.innerHTML = `Error: ${err.message}`;
    }
}

// IDB Utils
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('docker-plugin-db', 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('blobs')) {
                db.createObjectStore('blobs');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getBlobFromDB(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('blobs', 'readonly');
        const store = tx.objectStore('blobs');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function deleteBlobFromDB(key) {
    const db = await openDB();
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(key);
}

init();
