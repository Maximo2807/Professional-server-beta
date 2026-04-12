const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const multer = require('multer');
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

// Crear carpeta de base de datos si no existe
if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });
if (!fsSync.existsSync(DB_FILE)) fsSync.writeFileSync(DB_FILE, JSON.stringify({}));

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.use(cors({ origin: "*" }));
app.use(express.json());
const io = new Server(server, { cors: { origin: "*" } });

// Función para obtener el contenedor activo de la base de datos
async function getActiveContainerInfo() {
    try {
        const db = JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
        const uids = Object.keys(db);
        if (uids.length === 0) return null;
        return db[uids[0]]; // Por ahora toma el primer servidor creado
    } catch(e) { return null; }
}

async function getMinecraftContainer() { 
    const info = await getActiveContainerInfo();
    if (!info) return null;
    try { 
        const c = docker.getContainer(info.containerName); 
        await c.inspect(); 
        return c; 
    } catch (e) { return null; } 
}

// --- RUTAS DE CREACIÓN Y VERIFICACIÓN (NUEVO) ---
app.get('/api/project/check', async (req, res) => {
    try {
        const uid = req.query.uid;
        const db = JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
        if (db[uid]) {
            res.json({ exists: true, projectConfig: db[uid] });
        } else {
            res.json({ exists: false });
        }
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/project/create', async (req, res) => {
    const { uid, edition, motd, address, software, version } = req.body;
    const containerName = `proserver-${uid.substring(0, 6)}`;
    
    let imageName = 'itzg/minecraft-server';
    let envVars = [
        "EULA=TRUE",
        `VERSION=${version}`,
        `MOTD=${motd}`,
        "RCON_PORT=25575",
        "RCON_PASSWORD=proservers123",
        "MEMORY=4G"
    ];

    if (edition === 'bedrock') {
        imageName = 'itzg/minecraft-bedrock-server';
        envVars = ["EULA=TRUE", `VERSION=${version}`, `SERVER_NAME=${motd}`];
    } else {
        if (software === 'Paper') envVars.push("TYPE=PAPER");
        else if (software === 'Forge') envVars.push("TYPE=FORGE");
        else envVars.push("TYPE=VANILLA");
    }

    try {
        // Tira de la imagen de Docker (puede tardar la primera vez)
        // await docker.pull(imageName); // Descomentar en produccion real si no existe la imagen local
        
        const container = await docker.createContainer({
            Image: imageName,
            name: containerName,
            Env: envVars,
            HostConfig: {
                PortBindings: {
                    "25565/tcp": [{ "HostPort": "25565" }],
                    "19132/udp": [{ "HostPort": "19132" }] // Para Bedrock
                },
                Binds: ["minecraft-data:/data"],
                NetworkMode: "minecraft-panel_minecraft-net"
            }
        });
        await container.start();

        // Guardar en la DB
        const db = JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
        db[uid] = { projectName: address, containerName, edition, software, version, motd };
        await fs.writeFile(DB_FILE, JSON.stringify(db));

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- RUTAS DEL DASHBOARD (STATUS, RCON, FILES) ---
app.get('/api/server/status', async (req, res) => { 
    const c = await getMinecraftContainer(); 
    if (!c) return res.status(404).json({ status: 'off' }); 
    const data = await c.inspect(); 
    res.json({ status: data.State.Status === 'running' ? 'on' : 'off' }); 
});

app.post('/api/server/:action(start|stop|restart)', async (req, res) => { 
    const c = await getMinecraftContainer(); 
    if (!c) return res.status(404).json({ error: "Contenedor no encontrado." }); 
    try { await c[req.params.action](); res.json({ success: true }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/server/stats', async (req, res) => {
    try {
        const c = await getMinecraftContainer();
        if (!c) return res.json({ cpu: '0%', ram: '0 MB', disk: '0' });
        const data = await c.inspect();
        if (data.State.Status !== 'running') return res.json({ cpu: '0%', ram: '0 MB', disk: '0' });

        const stats = await c.stats({ stream: false });
        const ramMB = (stats.memory_stats.usage / 1024 / 1024).toFixed(1) + ' MB';
        let cpuPercent = '0.0';
        try {
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            if (systemDelta > 0 && cpuDelta > 0) cpuPercent = ((cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100).toFixed(1);
        } catch(e) {}
        res.json({ cpu: `${cpuPercent}%`, ram: ramMB, disk: '5' }); // Disco simplificado para beta
    } catch(e) { res.json({ cpu: '0%', ram: '0 MB', disk: '0' }); }
});

async function executeRconCommand(command) { 
    const info = await getActiveContainerInfo();
    if(!info || info.edition === 'bedrock') return null; // RCON suele ser de Java
    try { 
        const rcon = await Rcon.connect({ host: info.containerName, port: 25575, password: "proservers123" }); 
        const response = await rcon.send(command); 
        await rcon.end(); return response; 
    } catch (e) { return null; } 
}

app.get('/api/server/players', async (req, res) => { 
    const response = await executeRconCommand('list'); 
    if (response === null) return res.status(500).json({ error: 'RCON offline o Bedrock.' }); 
    const match = response.match(/online:(.*)/); 
    if (!match || !match[1]) return res.json({ players: [] }); 
    const playerNames = match[1].trim().split(', ').filter(Boolean); 
    res.json({ players: playerNames.map(name => ({ name, avatar: `https://cravatar.eu/helmavatar/${name}/80.png` })) }); 
});

app.post('/api/server/command', async (req, res) => { await executeRconCommand(req.body.command); res.json({ success: true }); });

app.get('/api/files/list', async (req, res) => { 
    try { 
        const reqPath = req.query.path || '/'; const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, ''); 
        const dirents = await fs.readdir(path.join(SERVER_DATA_PATH, safePath), { withFileTypes: true }); 
        res.json(await Promise.all(dirents.map(async (d) => ({ name: d.name, isDir: d.isDirectory(), path: path.join(safePath, d.name) })))); 
    } catch (e) { res.status(500).json({ error: 'Error al leer archivos.' }); } 
});

app.get('/api/files/content', async (req, res) => { 
    try { res.json({ content: await fs.readFile(path.join(SERVER_DATA_PATH, path.normalize(req.query.path).replace(/^(\.\.(\/|\\|$))+/, '')), 'utf-8') }); } 
    catch (e) { res.status(500).json({ error: 'Error.' }); } 
});

app.post('/api/files/save', async (req, res) => {
    try { await fs.writeFile(path.join(SERVER_DATA_PATH, path.normalize(req.body.path).replace(/^(\.\.(\/|\\|$))+/, '')), req.body.content); res.json({ success: true }); } 
    catch(e) { res.status(500).json({ error: 'Error.' }); }
});

// --- RUTAS DE NUBE (GDRIVE / ONEDRIVE) ---
async function createZip(zipPath) {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const zipPromise = new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); });
    archive.pipe(output); archive.directory(SERVER_DATA_PATH, false); archive.finalize();
    await zipPromise;
}

app.post('/api/backup/gdrive', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token.' });
    const zipName = `Respaldo_${Date.now()}.zip`; const zipPath = path.join(__dirname, zipName);
    try {
        await createZip(zipPath);
        const authClient = new google.auth.OAuth2(); authClient.setCredentials({ access_token: token });
        const drive = google.drive({ version: 'v3', auth: authClient });
        await drive.files.create({ resource: { name: zipName }, media: { mimeType: 'application/zip', body: fsSync.createReadStream(zipPath) } });
        if (fsSync.existsSync(zipPath)) fsSync.unlinkSync(zipPath);
        res.json({ success: true, name: zipName });
    } catch (error) { if (fsSync.existsSync(zipPath)) fsSync.unlinkSync(zipPath); res.status(500).json({ error: error.message }); }
});

app.post('/api/backup/onedrive', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token.' });
    const zipName = `Respaldo_${Date.now()}.zip`; const zipPath = path.join(__dirname, zipName);
    try {
        await createZip(zipPath);
        const fileBuffer = await fs.readFile(zipPath);
        const msRes = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${zipName}:/content`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/zip' }, body: fileBuffer });
        if (!msRes.ok) throw new Error(await msRes.text());
        if (fsSync.existsSync(zipPath)) fsSync.unlinkSync(zipPath);
        res.json({ success: true, name: zipName });
    } catch (error) { if (fsSync.existsSync(zipPath)) fsSync.unlinkSync(zipPath); res.status(500).json({ error: error.message }); }
});

io.on('connection', async (socket) => { 
    const c = await getMinecraftContainer(); if (!c) return; 
    const logStream = await c.logs({ follow: true, stdout: true, stderr: true, tail: 100 }); 
    logStream.on('data', chunk => socket.emit('log', chunk.toString('utf8'))); 
    socket.on('disconnect', () => logStream.destroy()); 
});

server.listen(PORT, () => console.log(`Backend V2 corriendo en puerto ${PORT}`));