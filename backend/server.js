// backend/server.js - VERSIÓN CON ESTADÍSTICAS Y REINICIO
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const multer = require('multer');
const { exec } = require('child_process');
const Docker = require('dockerode');
const { Rcon } = require('rcon-client');

const app = express();
const server = http.createServer(app);
const PORT = 3000;
const SERVER_DATA_PATH = process.env.SERVER_DATA_PATH || '/minecraft-server-data';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const { MINECRAFT_CONTAINER_NAME, MINECRAFT_RCON_HOST, MINECRAFT_RCON_PORT, MINECRAFT_RCON_PASSWORD } = process.env;

app.use(cors({ origin: "*" }));
app.use(express.json());
const io = new Server(server, { cors: { origin: "*" } });

// --- Control del Servidor ---
async function getMinecraftContainer() { 
    try { 
        const c = docker.getContainer(MINECRAFT_CONTAINER_NAME); 
        await c.inspect(); 
        return c; 
    } catch (e) { return null; } 
}

app.get('/api/server/status', async (req, res) => { 
    const c = await getMinecraftContainer(); 
    if (!c) return res.status(404).json({ status: 'off' }); 
    const data = await c.inspect(); 
    res.json({ status: data.State.Status === 'running' ? 'on' : 'off' }); 
});

// AHORA ACEPTA START, STOP Y RESTART
app.post('/api/server/:action(start|stop|restart)', async (req, res) => { 
    const c = await getMinecraftContainer(); 
    if (!c) return res.status(404).send(); 
    await c[req.params.action](); 
    res.json({ success: true }); 
});

// --- Estadísticas en tiempo real (CPU, RAM, Disco) ---
app.get('/api/server/stats', async (req, res) => {
    try {
        const c = await getMinecraftContainer();
        if (!c) return res.json({ cpu: '0%', ram: '0 MB', disk: '0 GB' });

        const data = await c.inspect();
        if (data.State.Status !== 'running') return res.json({ cpu: '0%', ram: '0 MB', disk: '0 GB' });

        const stats = await c.stats({ stream: false });
        
        // RAM
        const ramUsage = stats.memory_stats.usage || 0;
        const ramMB = (ramUsage / 1024 / 1024).toFixed(1) + ' MB';
        
        // CPU
        let cpuPercent = '0.0';
        try {
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            if (systemDelta > 0 && cpuDelta > 0) {
                cpuPercent = ((cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100).toFixed(1);
            }
        } catch(e) {}

        // Disco (Ejecuta un df -h dentro del contenedor para leer el peso de /data)
        let diskUsage = 'N/A';
        try {
            const exec = await c.exec({ Cmd: ['df', '-h', '/data'], AttachStdout: true, AttachStderr: true });
            const stream = await exec.start({ hijack: true, detach: false });
            const output = await new Promise((resolve) => {
                let out = '';
                stream.on('data', chunk => out += chunk.toString('utf8'));
                stream.on('end', () => resolve(out));
            });
            const lines = output.split('\n');
            if (lines[1]) {
                const parts = lines[1].trim().split(/\s+/);
                diskUsage = parts[2] || 'N/A'; 
            }
        } catch(e) { diskUsage = '0 GB'; }

        res.json({ cpu: `${cpuPercent}%`, ram: ramMB, disk: diskUsage });
    } catch(e) {
        res.json({ cpu: '0%', ram: '0 MB', disk: '0 GB' });
    }
});

// --- RCON y Jugadores ---
async function executeRconCommand(command) { 
    try { 
        const rcon = await Rcon.connect({ host: MINECRAFT_RCON_HOST, port: MINECRAFT_RCON_PORT, password: MINECRAFT_RCON_PASSWORD }); 
        const response = await rcon.send(command); 
        await rcon.end(); 
        return response; 
    } catch (e) { 
        console.error("RCON Error:", e.message); 
        return null; 
    } 
}

app.get('/api/server/players', async (req, res) => { 
    const response = await executeRconCommand('list'); 
    if (response === null) return res.status(500).json({ error: 'No se pudo conectar con RCON.' }); 
    const match = response.match(/online:(.*)/); 
    if (!match || !match[1]) return res.json({ players: [] }); 
    const playerNames = match[1].trim().split(', ').filter(Boolean); 
    const players = playerNames.map(name => ({ name, avatar: `https://cravatar.eu/helmavatar/${name}/80.png` })); 
    res.json({ players }); 
});

app.post('/api/server/command', async (req, res) => { 
    await executeRconCommand(req.body.command); 
    res.json({ success: true }); 
});

// --- Explorador de Archivos ---
app.get('/api/files/list', async (req, res) => { 
    try { 
        const reqPath = req.query.path || '/'; 
        const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, ''); 
        const fullPath = path.join(SERVER_DATA_PATH, safePath); 
        const dirents = await fs.readdir(fullPath, { withFileTypes: true }); 
        const files = await Promise.all(dirents.map(async (d) => ({ name: d.name, isDir: d.isDirectory(), path: path.join(safePath, d.name) }))); 
        res.json(files); 
    } catch (e) { res.status(500).json({ error: 'Error al leer archivos.' }); } 
});

app.get('/api/files/content', async (req, res) => { 
    try { 
        const reqPath = req.query.path; 
        const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, ''); 
        const fullPath = path.join(SERVER_DATA_PATH, safePath); 
        const content = await fs.readFile(fullPath, 'utf-8'); 
        res.json({ content }); 
    } catch (e) { res.status(500).json({ error: 'Error al leer el archivo.' }); } 
});

// --- Mods y Ajustes ---
const storage = multer.diskStorage({ 
    destination: (req, file, cb) => { 
        const d = path.join(SERVER_DATA_PATH, 'mods'); 
        fsSync.mkdirSync(d, { recursive: true }); 
        cb(null, d); 
    }, 
    filename: (req, file, cb) => cb(null, file.originalname) 
});
const upload = multer({ storage });

app.get('/api/mods/list', async (req, res) => { 
    try { 
        const mods = await fs.readdir(path.join(SERVER_DATA_PATH, 'mods')); 
        res.json({ mods: mods.filter(f => f.endsWith('.jar')) }); 
    } catch (e) { res.json({ mods: [] }); } 
});

app.post('/api/mods/upload', upload.array('mods'), (req, res) => { 
    res.json({ success: true, message: `${req.files.length} mods subidos.` }); 
});

app.get('/api/server/settings', async (req, res) => { 
    res.json({ VERSION: process.env.VERSION || '1.20.1', TYPE: process.env.TYPE || 'FORGE', FORGE_VERSION: process.env.FORGE_VERSION || '47.4.3' }); 
});

app.post('/api/server/recreate', async (req, res) => { 
    res.json({ success: true, message: "Función de recrear en construcción."}); 
});

// --- Socket para Consola en Vivo ---
io.on('connection', async (socket) => { 
    const c = await getMinecraftContainer(); 
    if (!c) return; 
    const logStream = await c.logs({ follow: true, stdout: true, stderr: true, tail: 100 }); 
    logStream.on('data', chunk => socket.emit('log', chunk.toString('utf8'))); 
    socket.on('disconnect', () => logStream.destroy()); 
});

server.listen(PORT, () => console.log(`Backend Profesional corriendo en puerto ${PORT}`));