// ==UserScript==
// @name         一键保存封面 (内置ZIP打包，优化解压结构)
// @namespace    https://example.com
// @version      6.1
// @description  右键图片弹出按钮，自动生成“标签页名.zip”，解压即得文件夹+原图（无冗余层级）
// @author       你
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    /* ========== 悬浮按钮逻辑 ========== */
    let floatBtn = null;
    let currentImg = null;

    function createFloatBtn(mx, my) {
        if (!floatBtn) {
            floatBtn = document.createElement('div');
            floatBtn.textContent = '保存封面';
            floatBtn.style.cssText = `
                position: fixed; z-index:2147483647; background:#2a7df6; color:#fff;
                padding:6px 14px; border-radius:5px; font-size:14px; cursor:pointer;
                box-shadow:0 3px 10px rgba(0,0,0,0.35); user-select:none; display:none;
                white-space:nowrap; pointer-events:auto;
            `;
            floatBtn.addEventListener('mouseenter', () => clearTimeout(floatBtn._t));
            floatBtn.addEventListener('mouseleave', () => startTimer());
            floatBtn.addEventListener('click', e => {
                e.stopPropagation(); e.preventDefault();
                if (currentImg) downloadAsZip(currentImg);
                hideFloatBtn(true);
            });
            document.body.appendChild(floatBtn);
        }
        const sx = window.scrollX, sy = window.scrollY;
        let l = mx + sx, t = my + sy - 35;
        const bw = floatBtn.offsetWidth || 80, bh = floatBtn.offsetHeight || 30;
        if (l + bw > window.innerWidth + sx) l = window.innerWidth + sx - bw - 5;
        if (t < sy) t = my + sy + 15;
        floatBtn.style.left = l + 'px'; floatBtn.style.top = t + 'px';
        floatBtn.style.display = 'block';
        startTimer();
    }
    function startTimer() {
        if (!floatBtn) return;
        clearTimeout(floatBtn._t);
        floatBtn._t = setTimeout(() => hideFloatBtn(), 10000);
    }
    function hideFloatBtn(immediate) {
        if (floatBtn) { floatBtn.style.display = 'none'; if (immediate) clearTimeout(floatBtn._t); }
    }
    function removeFloatBtn() {
        if (floatBtn) { clearTimeout(floatBtn._t); floatBtn.remove(); floatBtn = null; }
    }

    /* ========== 辅助工具 ========== */
    function sanitize(name) {
        let c = name.replace(/[\\/:*?"<>|]/g, '_').trim().replace(/\.+$/, '');
        return c || '未命名';
    }
    function getFilename(url) {
        try {
            const p = new URL(url).pathname.split('/').pop();
            if (/\.(jpe?g|png|gif|webp|bmp|svg|ico|tiff?|avif|heic|heif)$/i.test(p)) return p;
        } catch(e) {}
        return 'cover.jpg';
    }

    /* ========== 轻量级 ZIP 生成（存储模式，仅包含文件，不包含文件夹条目） ========== */
    function generateZip(fileName, fileBlob) {
        const encoder = new TextEncoder();
        function strToU8(str) { return encoder.encode(str); }

        return fileBlob.arrayBuffer().then(fileData => {
            const fileBytes = new Uint8Array(fileData);
            const filePathBytes = strToU8(fileName);

            // 简单 CRC32 实现
            function crc32(data) {
                let crc = 0xFFFFFFFF;
                for (let i = 0; i < data.length; i++) {
                    crc ^= data[i];
                    for (let j = 0; j < 8; j++) {
                        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
                    }
                }
                return (crc ^ 0xFFFFFFFF) >>> 0;
            }

            const fileCrc = crc32(fileBytes);

            // 本地文件头
            const localHeader = new Uint8Array(30 + filePathBytes.length);
            const localView = new DataView(localHeader.buffer);
            localView.setUint32(0, 0x04034b50, true);  // local header signature
            localView.setUint16(4, 20, true);          // version needed
            localView.setUint16(6, 0x0800, true);      // general purpose bit flag: UTF-8
            localView.setUint16(8, 0, true);           // compression: store
            localView.setUint16(10, 0, true);          // mod time
            localView.setUint16(12, 0, true);          // mod date
            localView.setUint32(14, fileCrc, true);
            localView.setUint32(18, fileBytes.length, true); // compressed size
            localView.setUint32(22, fileBytes.length, true); // uncompressed size
            localView.setUint16(26, filePathBytes.length, true);
            localView.setUint16(28, 0, true);          // extra field length
            localHeader.set(filePathBytes, 30);

            // 中央目录记录
            const centralDir = new Uint8Array(46 + filePathBytes.length);
            const centralView = new DataView(centralDir.buffer);
            centralView.setUint32(0, 0x02014b50, true); // central signature
            centralView.setUint16(4, 20, true);         // version made by
            centralView.setUint16(6, 20, true);         // version needed
            centralView.setUint16(8, 0x0800, true);     // general purpose
            centralView.setUint16(10, 0, true);         // compression
            centralView.setUint16(12, 0, true);         // mod time
            centralView.setUint16(14, 0, true);         // mod date
            centralView.setUint32(16, fileCrc, true);
            centralView.setUint32(20, fileBytes.length, true);
            centralView.setUint32(24, fileBytes.length, true);
            centralView.setUint16(28, filePathBytes.length, true);
            centralView.setUint16(30, 0, true);         // extra field
            centralView.setUint16(32, 0, true);         // comment
            centralView.setUint16(34, 0, true);         // disk start
            centralView.setUint16(36, 0, true);         // internal attributes (file)
            centralView.setUint32(38, 0, true);         // external attributes
            centralView.setUint32(42, 0, true);         // local header offset (it's at beginning)
            centralDir.set(filePathBytes, 46);

            // EOCD
            const eocd = new Uint8Array(22);
            const eocdView = new DataView(eocd.buffer);
            eocdView.setUint32(0, 0x06054b50, true);    // EOCD signature
            eocdView.setUint16(4, 0, true);             // disk number
            eocdView.setUint16(6, 0, true);             // disk with central dir
            eocdView.setUint16(8, 1, true);             // entries on this disk (only 1 file)
            eocdView.setUint16(10, 1, true);            // total entries
            eocdView.setUint32(12, centralDir.length, true); // central dir size
            eocdView.setUint32(16, localHeader.length + fileBytes.length, true); // offset of central dir
            eocdView.setUint16(20, 0, true);            // comment length

            // 拼接最终 ZIP 数组
            const totalLength = localHeader.length + fileBytes.length + centralDir.length + eocd.length;
            const zipBuffer = new Uint8Array(totalLength);
            let offset = 0;
            zipBuffer.set(localHeader, offset); offset += localHeader.length;
            zipBuffer.set(fileBytes, offset); offset += fileBytes.length;
            zipBuffer.set(centralDir, offset); offset += centralDir.length;
            zipBuffer.set(eocd, offset);

            return new Blob([zipBuffer], { type: 'application/zip' });
        });
    }

    /* ========== 核心下载打包 ========== */
    function downloadAsZip(img) {
        const src = img.src || img.currentSrc;
        if (!src) {
            alert('未找到图片地址');
            return;
        }
        const folder = sanitize(document.title || '未命名');
        const filename = getFilename(src);

        showToast('⏳ 正在下载图片并打包...');

        GM_xmlhttpRequest({
            method: 'GET',
            url: src,
            responseType: 'blob',
            timeout: 10000,
            onload: function(res) {
                if (res.status >= 200 && res.status < 300) {
                    const blob = res.response;
                    // 只传文件名，不再包含文件夹路径
                    generateZip(filename, blob).then(zipBlob => {
                        const zipUrl = URL.createObjectURL(zipBlob);
                        GM_download({
                            url: zipUrl,
                            name: folder + '.zip',   // 压缩包名为“标签页名.zip”
                            saveAs: false,
                            onload: () => {
                                showToast('✅ 下载完成！用解压软件“解压到 ' + folder + '”即可');
                                setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
                            },
                            onerror: (e) => {
                                showToast('❌ 下载失败，请重试');
                                console.error(e);
                                URL.revokeObjectURL(zipUrl);
                            }
                        });
                    }).catch(err => {
                        showToast('❌ 打包失败: ' + err.message);
                        console.error(err);
                    });
                } else {
                    showToast('❌ 图片请求失败，状态码: ' + res.status);
                }
            },
            onerror: () => showToast('❌ 网络错误，无法获取图片'),
            ontimeout: () => showToast('❌ 请求超时')
        });
    }

    function showToast(msg) {
        let t = document.getElementById('cover-save-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'cover-save-toast';
            t.style.cssText = `
                position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
                background:rgba(0,0,0,0.8); color:#fff; padding:8px 16px;
                border-radius:4px; font-size:14px; z-index:9999999;
                pointer-events:none; transition:opacity 0.3s;
            `;
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t._to);
        t._to = setTimeout(() => t.style.opacity = '0', 3000);
    }

    /* ========== 事件监听 ========== */
    document.addEventListener('contextmenu', function(e) {
        if (e.target.tagName === 'IMG') {
            currentImg = e.target;
            removeFloatBtn();
            createFloatBtn(e.clientX, e.clientY);
        } else {
            removeFloatBtn(); currentImg = null;
        }
    }, true);

    const hideAction = () => {
        if (floatBtn && floatBtn.style.display === 'block') setTimeout(hideFloatBtn, 150);
    };
    document.addEventListener('click', hideAction, false);
    window.addEventListener('scroll', hideAction, false);
    window.addEventListener('resize', hideAction, false);
    window.addEventListener('beforeunload', removeFloatBtn);

})();