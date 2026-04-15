const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const docker = new Docker();

app.use(cors());
app.use(express.json());

// Base de datos simple basada en JSON
const dbPath = path.join(__dirname, 'database.json');
function loadDB() {
    if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({ users: {} }));
    return JSON.parse(fs.readFileSync(dbPath));
}
function saveDB(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// ==========================================
// RUTAS DE PROYECTOS (CREAR, BORRAR, CHECK)
// ==========================================

app.get('/api/project/check', (req, res) => {
    const db = loadDB();
    const userServers = db.users[req.query.uid] || [];
    res.json({ exists: userServers.length > 0, servers: userServers });
});

app.post('/api/project/create', async (req, res) => {
    const { uid, edition, projectName, motd, software, version } = req.body;
    const db = loadDB();
    if (!db.users[uid]) db.users[uid] = [];

    const serverId = Date.now().toString();
    const newServer = { id: serverId, edition, projectName, motd, software, version, publicIp: null };
    
    db.users[uid].push(newServer);
    saveDB(db);

    // FIX NGrok: Respondemos rápido para evitar el error de "Unexpected token" (Timeout)
    res.json({ success: true, message: "Creando en segundo plano" });

    // Hacemos el trabajo pesado en segundo plano
    try {
        const mcContainerName = `mc-${serverId}`;
        const playitContainerName = `playit-${serverId}`;
        const serverPath = path.join(__dirname, 'servers', serverId);
        if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });

        // Contenedor de Minecraft (ITZG) - PREPARADO PARA 8GB (Azure)
        await docker.createContainer({
            Image: 'itzg/minecraft-server',
            name: mcContainerName,
            Env: [
                'EULA=TRUE',
                `VERSION=${version}`,
                `TYPE=${software.toUpperCase()}`,
                `MOTD=${motd}`,
                'MEMORY=8G' // ASIGNACIÓN DE 8GB REALES
            ],
            HostConfig: {
                Memory: 8589934592, // 8GB en Bytes
                Binds: [`${serverPath}:/data`]
            }
        }).then(container => container.start());

        // Contenedor de Playit.gg
        await docker.createContainer({
            Image: 'playitgg/playit',
            name: playitContainerName,
            HostConfig: { NetworkMode: `container:${mcContainerName}` } // Se cuelga de la red del MC
        }).then(container => container.start());

    } catch (err) {
        console.error("Error creando contenedores de fondo:", err);
    }
});

app.post('/api/project/delete', async (req, res) => {
    const { uid, serverId } = req.body;
    const db = loadDB();
    if (db.users[uid]) {
        db.users[uid] = db.users[uid].filter(s => s.id !== serverId);
        saveDB(db);
    }

    // FIX: Limpieza extrema de contenedores
    try {
        const mc = docker.getContainer(`mc-${serverId}`);
        await mc.stop().catch(() => {});
        await mc.remove({ force: true, v: true }).catch(() => {});

        const playit = docker.getContainer(`playit-${serverId}`);
        await playit.stop().catch(() => {});
        await playit.remove({ force: true, v: true }).catch(() => {});
        
        // Opcional: Borrar carpeta de archivos (descomentar si querés borrar todo el mundo al eliminar)
        // fs.rmSync(path.join(__dirname, 'servers', serverId), { recursive: true, force: true });
    } catch (e) {}

    res.json({ success: true });
});

app.post('/api/project/ip', (req, res) => {
    const { uid, serverId, ip } = req.body;
    const db = loadDB();
    const server = db.users[uid]?.find(s => s.id === serverId);
    if (server) { server.publicIp = ip; saveDB(db); }
    res.json({ success: true });
});

// ==========================================
// RUTAS DE GESTIÓN DEL SERVIDOR (ON/OFF, STATS)
// ==========================================

app.get('/api/server/status', async (req, res) => {
    try {
        const container = docker.getContainer(`mc-${req.query.serverId}`);
        const data = await container.inspect();
        res.json({ status: data.State.Running ? 'on' : 'off' });
    } catch (e) { res.json({ status: 'off' }); }
});

app.post('/api/server/start', async (req, res) => {
    try { await docker.getContainer(`mc-${req.body.serverId}`).start(); res.json({ success: true }); } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/server/stop', async (req, res) => {
    try { await docker.getContainer(`mc-${req.body.serverId}`).stop(); res.json({ success: true }); } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/server/restart', async (req, res) => {
    try { await docker.getContainer(`mc-${req.body.serverId}`).restart(); res.json({ success: true }); } catch(e) { res.json({ error: e.message }); }
});

app.get('/api/server/stats', async (req, res) => {
    try {
        const container = docker.getContainer(`mc-${req.query.serverId}`);
        const stats = await container.stats({ stream: false });
        // Cálculo de Docker CPU y RAM
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        let cpu = 0;
        if (systemDelta > 0 && cpuDelta > 0) cpu = ((cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100).toFixed(1);
        const ram = (stats.memory_stats.usage / (1024 * 1024)).toFixed(2); // MB
        res.json({ cpu: `${cpu}%`, ram });
    } catch (e) { res.json({ cpu: '0%', ram: '0' }); }
});

// ==========================================
// RUTAS DE JUGADORES Y COMANDOS (FIX RCON)
// ==========================================

app.post('/api/server/command', async (req, res) => {
    const { serverId, command } = req.body;
    if (!command) return res.status(400).json({ error: "Comando vacío" });
    try {
        const container = docker.getContainer(`mc-${serverId}`);
        const exec = await container.exec({ Cmd: ['rcon-cli', command], AttachStdout: true, AttachStderr: true });
        exec.start((err, stream) => res.json({ success: true }));
    } catch (e) { res.status(500).json({ error: "Error de comando" }); }
});

app.post('/api/server/kick', async (req, res) => {
    const { serverId, player } = req.body;
    try {
        const container = docker.getContainer(`mc-${serverId}`);
        const exec = await container.exec({ Cmd: ['rcon-cli', 'kick', player], AttachStdout: true });
        exec.start((err, stream) => res.json({ success: true }));
    } catch (e) { res.status(500).json({ error: "Error al expulsar" }); }
});

app.post('/api/server/ban', async (req, res) => {
    const { serverId, player } = req.body;
    try {
        const container = docker.getContainer(`mc-${serverId}`);
        const exec = await container.exec({ Cmd: ['rcon-cli', 'ban', player], AttachStdout: true });
        exec.start((err, stream) => res.json({ success: true }));
    } catch (e) { res.status(500).json({ error: "Error al banear" }); }
});

app.get('/api/server/players', async (req, res) => {
    try {
        const container = docker.getContainer(`mc-${req.query.serverId}`);
        const exec = await container.exec({ Cmd: ['rcon-cli', 'list'], AttachStdout: true });
        exec.start((err, stream) => {
            if (err) return res.json({ players: [] });
            let output = '';
            stream.on('data', chunk => output += chunk.toString());
            stream.on('end', () => {
                // Parseamos la salida de Minecraft: "There are X of a max of Y players online: maxpro, steve"
                const players = [];
                const parts = output.split(':');
                if (parts.length > 1 && parts[1].trim() !== '') {
                    const names = parts[1].split(',').map(n => n.trim());
                    names.forEach(n => {
                        if(n) players.push({ name: n, avatar: `https://minotar.net/helm/${n}/100.png` });
                    });
                }
                res.json({ players });
            });
        });
    } catch (e) { res.json({ players: [] }); }
});

// ==========================================
// RUTAS DE ARCHIVOS Y LOGS PLAYIT
// ==========================================

app.get('/api/files/list', (req, res) => {
    const { serverId } = req.query;
    let targetPath = req.query.path || '/';
    if (targetPath.includes('..')) targetPath = '/'; // Seguridad básica
    
    const fullPath = path.join(__dirname, 'servers', serverId, targetPath);
    if (!fs.existsSync(fullPath)) return res.json([]);

    const items = fs.readdirSync(fullPath, { withFileTypes: true }).map(dirent => ({
        name: dirent.name,
        isDir: dirent.isDirectory(),
        path: path.join(targetPath, dirent.name)
    }));
    res.json(items);
});

app.get('/api/files/content', (req, res) => {
    const { serverId, path: filePath } = req.query;
    if (filePath.includes('..')) return res.status(403).json({ error: 'Acceso denegado' });
    const fullPath = path.join(__dirname, 'servers', serverId, filePath);
    if (fs.existsSync(fullPath)) res.json({ content: fs.readFileSync(fullPath, 'utf8') });
    else res.status(404).json({ error: 'No encontrado' });
});

app.post('/api/files/save', (req, res) => {
    const { serverId, path: filePath, content } = req.body;
    if (filePath.includes('..')) return res.status(403).json({ error: 'Acceso denegado' });
    const fullPath = path.join(__dirname, 'servers', serverId, filePath);
    fs.writeFileSync(fullPath, content, 'utf8');
    res.json({ success: true });
});

app.get('/api/server/playitlogs', async (req, res) => {
    try {
        const container = docker.getContainer(`playit-${req.query.serverId}`);
        const logs = await container.logs({ stdout: true, stderr: true, tail: 50 });
        res.json({ logs: logs.toString('utf8').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '') });
    } catch (e) { res.json({ logs: "Esperando a Playit.gg..." }); }
});

// ==========================================
// WEBSOCKETS (CONSOLA EN VIVO MC)
// ==========================================
io.on('connection', (socket) => {
    const { serverId } = socket.handshake.query;
    if (!serverId) return socket.disconnect();

    const container = docker.getContainer(`mc-${serverId}`);
    let logStream;

    container.logs({ follow: true, stdout: true, stderr: true, tail: 50 }, (err, stream) => {
        if (err || !stream) return;
        logStream = stream;
        stream.on('data', chunk => socket.emit('log', chunk.toString('utf8')));
    });

    socket.on('disconnect', () => { if (logStream) logStream.destroy(); });
});

server.listen(3000, () => console.log('Backend Professional Servers corriendo en puerto 3000'));