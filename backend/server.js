const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const Docker = require('dockerode');
const { Rcon } = require('rcon-client');
const archiver = require('archiver');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const PORT = 3000;
const SERVER_DATA_PATH = process.env.SERVER_DATA_PATH || '/minecraft-server-data';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'projects.json');

if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });
if (!fsSync.existsSync(DB_FILE)) fsSync.writeFileSync(DB_FILE, JSON.stringify({}));

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.use(cors({ origin: "*" }));
app.use(express.json());
const io = new Server(server, { cors: { origin: "*" } });

async function getActiveContainerInfo(req) {
    try {
        const uid = req.query.uid || req.body.uid;
        const serverId = req.query.serverId || req.body.serverId;
        if (!uid || !serverId) return null;
        
        const db = JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
        let userServers = db[uid] || [];
        
        if (!Array.isArray(userServers)) {
            userServers.id = "migrated_1";
            db[uid] = [userServers];
            await fs.writeFile(DB_FILE, JSON.stringify(db));
            userServers = db[uid];
        }
        
        return userServers.find(s => s.id === serverId) || null; 
    } catch(e) { return null; }
}

async function getMinecraftContainer(req) { 
    const info = await getActiveContainerInfo(req);
    if (!info) return null;
    try { 
        const c = docker.getContainer(info.containerName); 
        await c.inspect(); 
        return c; 
    } catch (e) { return null; } 
}

app.get('/api/project/check', async (req, res) => {
    try {
        const uid = req.query.uid;
        const db = JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
        
        let userServers = db[uid] || [];
        if (!Array.isArray(userServers) && userServers.projectName) {
            userServers.id = Date.now().toString();
            db[uid] = [userServers];
            await fs.writeFile(DB_FILE, JSON.stringify(db));
            userServers = db[uid];
        }
        
        res.json({ exists: userServers.length > 0, servers: userServers });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/project/create', async (req, res) => {
    const { uid, edition, motd, address, software, version } = req.body;
    
    try {
        const db = JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
        if (!db[uid]) db[uid] = [];
        
        if (db[uid].length >= 2) {
            return res.status(400).json({ error: "Has alcanzado el límite de 2 servidores gratuitos." });
        }

        const serverId = Date.now().toString();
        const containerName = `proserver-${uid.substring(0, 4)}-${serverId.substring(8)}`;
        const playitContainerName = `playit-${uid.substring(0, 4)}-${serverId.substring(8)}`;
        
        let imageName = 'itzg/minecraft-server:latest';
        let envVars = [
            "EULA=TRUE", 
            `VERSION=${version}`, 
            `MOTD=${motd}`, 
            "RCON_PORT=25575", 
            "RCON_PASSWORD=proservers123", 
            "MEMORY=4G",
            "SERVER_PORT=25565" 
        ];

        if (edition === 'bedrock') {
            imageName = 'itzg/minecraft-bedrock-server:latest';
            envVars = ["EULA=TRUE", `VERSION=${version}`, `SERVER_NAME=${motd}`, "SERVER_PORT=19132"];
        } else {
            if (software === 'Paper') envVars.push("TYPE=PAPER");
            else if (software === 'Forge') envVars.push("TYPE=FORGE");
            else envVars.push("TYPE=VANILLA");
        }

        const pullImage = (img) => new Promise((resolve, reject) => {
            docker.pull(img, (err, stream) => {
                if (err) return reject(err);
                docker.modem.followProgress(stream, (err, output) => { if (err) return reject(err); resolve(output); });
            });
        });

        try { await pullImage(imageName); } catch (e) {}
        
        // EL ARREGLO DE RCON: Vuelve a la red compartida
        const container = await docker.createContainer({
            Image: imageName, name: containerName, Env: envVars,
            HostConfig: { 
                Binds: [`minecraft-data-${serverId}:/data`], 
                NetworkMode: "minecraft-panel_minecraft-net" 
            }
        });
        await container.start();

        const playitImage = 'pepaondrugs/playitgg-docker:latest';
        try {
            await pullImage(playitImage);
            const playitContainer = await docker.createContainer({ 
                Image: playitImage, name: playitContainerName, 
                HostConfig: { NetworkMode: `container:${containerName}` } 
            });
            await playitContainer.start();
        } catch(e) { console.log("Error Playit: ", e.message); }

        db[uid].push({ 
            id: serverId, projectName: address, containerName, playitContainerName, 
            edition, software, version, motd, publicIp: null 
        });
        await fs.writeFile(DB_FILE, JSON.stringify(db));

        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/project/delete', async (req, res) => {
    try {
        const { uid, serverId } = req.body;
        const db = JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
        
        if (!db[uid]) return res.status(404).json({ error: "Usuario no encontrado" });
        
        const serverIndex = db[uid].findIndex(s => s.id === serverId);
        if (serverIndex === -1) return res.status(404).json({ error: "Servidor no encontrado" });

        const server = db[uid][serverIndex];

        try { 
            const c1 = docker.getContainer(server.containerName); 
            await c1.stop().catch(e=>e); await c1.remove().catch(e=>e); 
        } catch(e){}
        try { 
            const c2 = docker.getContainer(server.playitContainerName); 
            await c2.stop().catch(e=>e); await c2.remove().catch(e=>e); 
        } catch(e){}

        db[uid].splice(serverIndex, 1);
        await fs.writeFile(DB_FILE, JSON.stringify(db));

        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/project/ip', async (req, res) => {
    try {
        const { uid, serverId, ip } = req.body;
        const db = JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
        if (db[uid]) {
            const server = db[uid].find(s => s.id === serverId);
            if (server) {
                server.publicIp = ip;
                await fs.writeFile(DB_FILE, JSON.stringify(db));
                return res.json({ success: true });
            }
        }
        res.status(404).json({ error: 'Servidor no encontrado' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/server/status', async (req, res) => { 
    const c = await getMinecraftContainer(req); 
    if (!c) return res.status(404).json({ status: 'off' }); 
    const data = await c.inspect(); res.json({ status: data.State.Status === 'running' ? 'on' : 'off' }); 
});

// EL ARREGLO DE LOS LOGS VACÍOS: Limpieza de basura binaria
app.get('/api/server/playitlogs', async (req, res) => {
    try {
        const info = await getActiveContainerInfo(req);
        if (!info || !info.playitContainerName) return res.json({ logs: 'Esperando contenedor de red...' });
        const pC = docker.getContainer(info.playitContainerName);
        const logsBuffer = await pC.logs({ stdout: true, stderr: true, tail: 100 });
        let logsText = logsBuffer.toString('utf8').replace(/[^\x20-\x7E\n]/g, '');
        res.json({ logs: logsText });
    } catch(e) { res.json({ logs: 'Conectando con consola de Playit...' }); }
});

app.post('/api/server/:action(start|stop|restart)', async (req, res) => { 
    const c = await getMinecraftContainer(req); 
    if (!c) return res.status(404).json({ error: "Contenedor no encontrado." }); 
    try { await c[req.params.action](); res.json({ success: true }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/server/stats', async (req, res) => {
    try {
        const c = await getMinecraftContainer(req); if (!c) return res.json({ cpu: '0%', ram: '0 MB', disk: '0' });
        const data = await c.inspect(); if (data.State.Status !== 'running') return res.json({ cpu: '0%', ram: '0 MB', disk: '0' });
        const stats = await c.stats({ stream: false });
        const ramMB = (stats.memory_stats.usage / 1024 / 1024).toFixed(1) + ' MB';
        let cpuPercent = '0.0';
        try {
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            if (systemDelta > 0 && cpuDelta > 0) cpuPercent = ((cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100).toFixed(1);
        } catch(e) {}
        res.json({ cpu: `${cpuPercent}%`, ram: ramMB, disk: '5' }); 
    } catch(e) { res.json({ cpu: '0%', ram: '0 MB', disk: '0' }); }
});

async function executeRconCommand(req, command) { 
    const info = await getActiveContainerInfo(req); if(!info || info.edition === 'bedrock') return null; 
    try { const rcon = await Rcon.connect({ host: info.containerName, port: 25575, password: "proservers123" }); const response = await rcon.send(command); await rcon.end(); return response; } catch (e) { return null; } 
}

app.get('/api/server/players', async (req, res) => { 
    const response = await executeRconCommand(req, 'list'); 
    if (response === null) return res.status(500).json({ error: 'RCON offline o Bedrock.' }); 
    const match = response.match(/online:(.*)/); if (!match || !match[1]) return res.json({ players: [] }); 
    const playerNames = match[1].trim().split(', ').filter(Boolean); res.json({ players: playerNames.map(name => ({ name, avatar: `https://cravatar.eu/helmavatar/${name}/80.png` })) }); 
});

app.post('/api/server/command', async (req, res) => { await executeRconCommand(req, req.body.command); res.json({ success: true }); });

app.get('/api/files/list', async (req, res) => { 
    try { const reqPath = req.query.path || '/'; const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, ''); const dirents = await fs.readdir(path.join(SERVER_DATA_PATH, safePath), { withFileTypes: true }); res.json(await Promise.all(dirents.map(async (d) => ({ name: d.name, isDir: d.isDirectory(), path: path.join(safePath, d.name) })))); } catch (e) { res.status(500).json({ error: 'Error' }); } 
});

app.get('/api/files/content', async (req, res) => { try { res.json({ content: await fs.readFile(path.join(SERVER_DATA_PATH, path.normalize(req.query.path).replace(/^(\.\.(\/|\\|$))+/, '')), 'utf-8') }); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.post('/api/files/save', async (req, res) => { try { await fs.writeFile(path.join(SERVER_DATA_PATH, path.normalize(req.body.path).replace(/^(\.\.(\/|\\|$))+/, '')), req.body.content); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Error' }); } });

async function createZip(zipPath) { const output = fsSync.createWriteStream(zipPath); const archive = archiver('zip', { zlib: { level: 9 } }); const zipPromise = new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); }); archive.pipe(output); archive.directory(SERVER_DATA_PATH, false); archive.finalize(); await zipPromise; }

app.post('/api/backup/gdrive', async (req, res) => { const { token } = req.body; if (!token) return res.status(400).json({ error: 'No token.' }); const zipName = `Respaldo_${Date.now()}.zip`; const zipPath = path.join(__dirname, zipName); try { await createZip(zipPath); const authClient = new google.auth.OAuth2(); authClient.setCredentials({ access_token: token }); const drive = google.drive({ version: 'v3', auth: authClient }); await drive.files.create({ resource: { name: zipName }, media: { mimeType: 'application/zip', body: fsSync.createReadStream(zipPath) } }); if (fsSync.existsSync(zipPath)) fsSync.unlinkSync(zipPath); res.json({ success: true, name: zipName }); } catch (error) { if (fsSync.existsSync(zipPath)) fsSync.unlinkSync(zipPath); res.status(500).json({ error: error.message }); } });
app.post('/api/backup/onedrive', async (req, res) => { const { token } = req.body; if (!token) return res.status(400).json({ error: 'No token.' }); const zipName = `Respaldo_${Date.now()}.zip`; const zipPath = path.join(__dirname, zipName); try { await createZip(zipPath); const fileBuffer = await fs.readFile(zipPath); const msRes = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${zipName}:/content`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/zip' }, body: fileBuffer }); if (!msRes.ok) throw new Error(await msRes.text()); if (fsSync.existsSync(zipPath)) fsSync.unlinkSync(zipPath); res.json({ success: true, name: zipName }); } catch (error) { if (fsSync.existsSync(zipPath)) fsSync.unlinkSync(zipPath); res.status(500).json({ error: error.message }); } });

io.on('connection', async (socket) => { 
    const req = { query: socket.handshake.query };
    const c = await getMinecraftContainer(req); 
    if (!c) return; 
    const logStream = await c.logs({ follow: true, stdout: true, stderr: true, tail: 100 }); 
    logStream.on('data', chunk => socket.emit('log', chunk.toString('utf8'))); 
    socket.on('disconnect', () => logStream.destroy()); 
});

server.listen(PORT, () => console.log(`Backend V2 corriendo en puerto ${PORT}`));