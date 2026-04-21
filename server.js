const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

const db = new sqlite3.Database('./seven.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        theme TEXT DEFAULT 'dark',
        notifications INTEGER DEFAULT 1,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user TEXT,
        to_user TEXT,
        to_channel TEXT,
        text TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_read INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        owner TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS channel_members (
        channel_id INTEGER,
        username TEXT
    )`);
});

let onlineUsers = new Map();

function cleanText(str) {
    if (!str) return '';
    return str.replace(/[^\w\s\-\.,!?@#\$%\^\&*\(\)\[\]{}:;"'`~]/g, '').trim().substring(0, 500);
}

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ error: 'Заполните все поля' });
    
    const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (cleanUsername.length < 3) return res.json({ error: 'Юзернейм минимум 3 символа (буквы, цифры, _)' });
    if (password.length < 4) return res.json({ error: 'Пароль минимум 4 символа' });
    
    const hashed = await bcrypt.hash(password, 10);
    
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [cleanUsername, hashed], (err) => {
        if (err) return res.json({ error: 'Юзернейм уже существует' });
        res.json({ success: true, username: cleanUsername });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ error: 'Заполните все поля' });
    
    const cleanUsername = username.trim().toLowerCase();
    
    db.get('SELECT * FROM users WHERE username = ?', [cleanUsername], async (err, user) => {
        if (!user) return res.json({ error: 'Неверный юзернейм или пароль' });
        
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.json({ error: 'Неверный юзернейм или пароль' });
        
        res.json({ success: true, username: user.username, theme: user.theme, notifications: user.notifications });
    });
});

app.get('/api/users', (req, res) => {
    db.all('SELECT username FROM users ORDER BY username', [], (err, users) => {
        res.json(users.map(u => u.username));
    });
});

app.get('/api/channels', (req, res) => {
    db.all('SELECT * FROM channels ORDER BY name', [], (err, channels) => {
        res.json(channels);
    });
});

app.post('/api/create_channel', (req, res) => {
    const { name, owner } = req.body;
    if (!name || !owner) return res.json({ error: 'Название канала обязательно' });
    
    const cleanName = name.trim().replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (cleanName.length < 3) return res.json({ error: 'Минимум 3 символа (буквы, цифры, _)' });
    
    db.run('INSERT INTO channels (name, owner) VALUES (?, ?)', [cleanName, owner], (err) => {
        if (err) return res.json({ error: 'Канал уже существует' });
        db.run('INSERT INTO channel_members (channel_id, username) SELECT id, ? FROM channels WHERE name = ?', [owner, cleanName]);
        res.json({ success: true, channel: cleanName });
    });
});

app.post('/api/join_channel', (req, res) => {
    const { channel, username } = req.body;
    db.get('SELECT id FROM channels WHERE name = ?', [channel], (err, ch) => {
        if (!ch) return res.json({ error: 'Канал не найден' });
        db.run('INSERT OR IGNORE INTO channel_members (channel_id, username) VALUES (?, ?)', [ch.id, username]);
        res.json({ success: true });
    });
});

app.post('/api/update_settings', (req, res) => {
    const { username, theme, notifications } = req.body;
    db.run('UPDATE users SET theme = ?, notifications = ? WHERE username = ?', [theme, notifications ? 1 : 0, username]);
    res.json({ success: true });
});

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('auth', (username) => {
        currentUser = username;
        onlineUsers.set(socket.id, currentUser);
        
        db.run('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE username = ?', [currentUser]);
        
        socket.emit('auth_ok', { username: currentUser });
        
        io.emit('users_online', Array.from(onlineUsers.values()));
        
        db.all(`SELECT m.*, u.username as from_user 
                FROM messages m 
                JOIN users u ON u.username = m.from_user 
                WHERE m.to_user = ? OR m.from_user = ? 
                ORDER BY m.timestamp DESC LIMIT 200`, 
                [currentUser, currentUser], (err, msgs) => {
            socket.emit('history', msgs.reverse());
        });
        
        db.all(`SELECT c.*, 
                (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) as members_count
                FROM channels c
                JOIN channel_members cm ON cm.channel_id = c.id
                WHERE cm.username = ?
                UNION
                SELECT c.*, 0 as members_count
                FROM channels c
                WHERE c.owner = ?`, [currentUser, currentUser], (err, channels) => {
            socket.emit('my_channels', channels);
        });
    });

    socket.on('send_private', (data) => {
        if (!currentUser) return;
        let text = cleanText(data.text);
        if (!text) return;
        
        db.run('INSERT INTO messages (from_user, to_user, text) VALUES (?, ?, ?)',
            [currentUser, data.to, text], function(err) {
            if (err) return;
            
            const msg = {
                id: this.lastID,
                from_user: currentUser,
                to_user: data.to,
                text: text,
                timestamp: new Date().toISOString()
            };
            
            socket.emit('new_message', msg);
            
            const targetSocket = [...onlineUsers.entries()].find(([_, user]) => user === data.to);
            if (targetSocket) {
                io.to(targetSocket[0]).emit('new_message', msg);
            }
        });
    });

    socket.on('send_channel', (data) => {
        if (!currentUser) return;
        let text = cleanText(data.text);
        if (!text) return;
        
        db.run('INSERT INTO messages (from_user, to_channel, text) VALUES (?, ?, ?)',
            [currentUser, data.channel, text], function(err) {
            if (err) return;
            
            const msg = {
                id: this.lastID,
                from_user: currentUser,
                to_channel: data.channel,
                text: text,
                timestamp: new Date().toISOString()
            };
            
            io.emit('channel_message', msg);
        });
    });

    socket.on('typing_private', (data) => {
        if (!currentUser) return;
        const targetSocket = [...onlineUsers.entries()].find(([_, user]) => user === data.to);
        if (targetSocket) {
            io.to(targetSocket[0]).emit('user_typing', { from: currentUser, isTyping: data.isTyping });
        }
    });

    socket.on('get_history', (data) => {
        db.all(`SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY timestamp ASC LIMIT 200`,
            [currentUser, data.with, data.with, currentUser], (err, msgs) => {
            socket.emit('history', msgs);
        });
    });

    socket.on('get_channel_history', (channel) => {
        db.all('SELECT * FROM messages WHERE to_channel = ? ORDER BY timestamp ASC LIMIT 200', [channel], (err, msgs) => {
            socket.emit('channel_history', msgs);
        });
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(socket.id);
            db.run('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE username = ?', [currentUser]);
            io.emit('users_online', Array.from(onlineUsers.values()));
        }
    });
});

server.listen(3000, () => {
    console.log('Seven Messenger running on http://localhost:3000');
});