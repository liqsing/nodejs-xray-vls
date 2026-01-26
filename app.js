#!/usr/bin/env node
// app.js - Xray内核 VLESS代理服务脚本
// 专为 64MB Pterodactyl 容器优化，支持路径持久化与多源ISP识别

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

// ======================================================================
// 核心配置区
// ======================================================================
const DOMAIN = process.env.DOMAIN || "example.com";   // 你的域名（Cloudflare 代理开启橙色云朵）
const UUID = process.env.UUID || "";                  // UUID变量，留空自动生成或写入固定值
const WSPATH = process.env.WSPATH || "";              // 留空则基于UUID生成固定路径
const PORT = process.env.PORT || "";                  // 留空将自动使用分配的端口
const NAME = process.env.NAME || "Panel";             // 节点名称前缀
// ======================================================================

class XrayProxy {
    constructor(domain, user_uuid, port, name) {
        this.uuid = user_uuid || crypto.randomUUID();
        
        if (WSPATH) {
            this.path = WSPATH.startsWith('/') ? WSPATH : '/' + WSPATH;
        } else {
            const hash = crypto.createHash('md5').update(this.uuid).digest('hex').slice(0, 8);
            this.path = '/' + hash;
        }
        
        this.domain = domain;
        this.port = port;
        this.process = null;
        this.xrayPath = path.join(__dirname, 'xray', 'xray');
        this.name = name;
        this.setupSignalHandlers();
    }

    setupSignalHandlers() {
        const cleanupAndExit = () => {
            console.log("\n正在停止服务...");
            this.cleanup();
            process.exit(0);
        };
        process.on('SIGINT', cleanupAndExit);
        process.on('SIGTERM', cleanupAndExit);
    }

    static async detectEnvironment() {
        const isPterodactyl = process.env.SERVER_IP && process.env.SERVER_PORT;
        if (isPterodactyl) {
            console.log(`✓ 检测到 Pterodactyl 环境 (端口: ${process.env.SERVER_PORT})`);
            return {
                serverIp: process.env.SERVER_IP,
                directPort: parseInt(process.env.SERVER_PORT)
            };
        } else {
            console.log("❌ Pterodactyl environment not detected.");
            process.exit(1);
        }
    }

    async getISP(retries = 3) {
        const apiSources = [
            {
                url: 'https://api.ip.sb/geoip',
                parse: (data) => {
                    const info = JSON.parse(data);
                    return `${info.country_code}-${info.organization}`.replace(/ /g, '_');
                }
            },
            {
                url: 'https://www.cloudflare.com/cdn-cgi/trace',
                parse: (data) => {
                    const kv = {};
                    data.split('\n').forEach(line => {
                        const parts = line.split('=');
                        if (parts.length >= 2) kv[parts[0].trim()] = parts[1].trim();
                    });
                    return `${kv.loc || 'UN'}-${kv.colo || 'CF'}`.replace(/ /g, '_');
                }
            }
        ];

        for (let attempt = 1; attempt <= retries; attempt++) {
            const source = apiSources[(attempt - 1) % apiSources.length];
            try {
                console.log(`[ISP] 尝试从 ${new URL(source.url).hostname} 获取信息...`);
                const isp = await new Promise((resolve, reject) => {
                    const req = https.get(source.url, { 
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        timeout: 5000 
                    }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve(source.parse(data)));
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
                });
                return isp;
            } catch (e) {
                console.log(`[ISP] 第 ${attempt} 次尝试失败: ${e.message}`);
                if (attempt === retries) return 'Unknown';
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    getXrayDownloadUrl() {
        const arch = os.arch() === 'arm64' ? "arm64-v8a" : "64";
        return `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${arch}.zip`;
    }

    async downloadAndExtract() {
        const url = this.getXrayDownloadUrl();
        const zipPath = 'xray.zip';
        
        try {
            console.log(`正在下载 Xray...`);
            await this._downloadFile(url, zipPath);
            
            return new Promise((resolve, reject) => {
                yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
                    if (err) return reject(err);
                    zipfile.on('entry', (entry) => {
                        if (entry.fileName === 'xray') {
                            zipfile.openReadStream(entry, (err, readStream) => {
                                if (err) return reject(err);
                                if (!fs.existsSync(path.dirname(this.xrayPath))) fs.mkdirSync(path.dirname(this.xrayPath));
                                const writeStream = fs.createWriteStream(this.xrayPath);
                                pipeline(readStream, writeStream).then(() => {
                                    fs.chmodSync(this.xrayPath, 0o755);
                                    fs.unlinkSync(zipPath);
                                    resolve(true);
                                }).catch(reject);
                            });
                        } else { zipfile.readEntry(); }
                    });
                    zipfile.readEntry();
                });
            });
        } catch (e) {
            console.error("下载/解压失败:", e.message);
            return false;
        }
    }

    async _downloadFile(url, dest) {
        return new Promise((resolve, reject) => {
            https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                if (res.statusCode >= 300 && res.headers.location) return this._downloadFile(res.headers.location, dest).then(resolve).catch(reject);
                const file = fs.createWriteStream(dest);
                res.pipe(file).on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
        });
    }

    generateConfig() {
        const config = {
            "log": { "loglevel": "error" },
            "inbounds": [{
                "port": this.port,
                "listen": "0.0.0.0",
                "protocol": "vless",
                "settings": { "clients": [{ "id": this.uuid, "level": 0 }], "decryption": "none" },
                "streamSettings": {
                    "network": "ws",
                    "security": "none",
                    "wsSettings": { "path": this.path, "headers": { "Host": this.domain } }
                }
            }],
            "outbounds": [{ "protocol": "freedom", "settings": {} }],
            "policy": { "levels": { "0": { "bufferSize": 64, "connIdle": 120 } } } // 64MB内存优化：降低缓冲区
        };
        fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    }

    displayInfo(ispInfo) {
        const nodeName = `${this.name}-${ispInfo}`;
        const cdnLink = `vless://${this.uuid}@${this.domain}:443?encryption=none&security=tls&type=ws&host=${encodeURIComponent(this.domain)}&path=${encodeURIComponent(this.path)}&sni=${encodeURIComponent(this.domain)}#${encodeURIComponent(nodeName)}`;
        
        const base64Link = Buffer.from(cdnLink).toString('base64');
        
        console.log("\n" + "=".repeat(50));
        console.log(`✅ Service is running...`);
        console.log("=".repeat(50));
        console.log(`\n🔐 Base64 编码（订阅）:`);
        console.log(base64Link);
        fs.writeFileSync('vless_xray_links.txt', base64Link);
    }

    startService() {
        const env = { ...process.env, GOMEMLIMIT: '12MiB', GOGC: '10' };
        this.process = spawn(this.xrayPath, ['run', '-config', 'config.json'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
        this.process.stderr.on('data', (d) => console.error(`[Xray] ${d}`));
    }

    cleanup() {
        if (this.process) this.process.kill('SIGTERM');
        ['xray.zip', 'config.json', 'vless_xray_links.txt'].forEach(f => {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e){}
        });
    }
}

async function main() {
    const env = await XrayProxy.detectEnvironment();
    const finalPort = PORT === "" ? env.directPort : parseInt(PORT);
    const proxy = new XrayProxy(DOMAIN, UUID, finalPort, NAME);

    const ispInfo = await proxy.getISP(3);

    if (await proxy.downloadAndExtract()) {
        proxy.generateConfig();
        proxy.displayInfo(ispInfo);
        proxy.startService();
    }
}

main().catch(console.error);
