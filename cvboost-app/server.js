const express = require('express');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'cvboost.db');

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload config
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

let db;

// ── DATABASE INIT ──
async function initDB() {
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        api_key TEXT,
        api_provider TEXT DEFAULT 'openai',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cvs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT,
        original_text TEXT,
        improved_text TEXT,
        file_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        cv_id TEXT,
        title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (cv_id) REFERENCES cvs(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        company TEXT,
        position TEXT,
        status TEXT DEFAULT 'applied',
        date_applied TEXT,
        notes TEXT,
        job_url TEXT,
        cover_letter TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        user_id TEXT PRIMARY KEY,
        target_role TEXT,
        location TEXT,
        experience_level TEXT,
        industry TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    saveDB();
    console.log('Database initialized');
}

function saveDB() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// ── HELPER: proxy AI calls from server side ──
function aiRequest(provider, apiKey, body) {
    return new Promise((resolve, reject) => {
        let options, postData;

        if (provider === 'openai') {
            postData = JSON.stringify(body);
            options = {
                hostname: 'api.openai.com',
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
        } else {
            postData = JSON.stringify(body);
            options = {
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        reject(new Error(parsed.error?.message || `API returned ${res.statusCode}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    reject(new Error('Failed to parse AI response'));
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ── AUTH: Simple user management ──
app.post('/api/users/register', (req, res) => {
    const { name, email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const existing = db.exec(`SELECT * FROM users WHERE email = ?`, [email]);
    if (existing.length > 0 && existing[0].values.length > 0) {
        const user = existing[0].values[0];
        return res.json({ id: user[0], name: user[1], email: user[2] });
    }

    const id = uuidv4();
    db.run(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`, [id, name || '', email]);
    saveDB();
    res.json({ id, name, email });
});

app.post('/api/users/login', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const result = db.exec(`SELECT id, name, email, api_provider FROM users WHERE email = ?`, [email]);
    if (result.length === 0 || result[0].values.length === 0) {
        return res.status(404).json({ error: 'User not found. Please register first.' });
    }
    const u = result[0].values[0];
    res.json({ id: u[0], name: u[1], email: u[2], api_provider: u[3] });
});

// ── API KEY ──
app.post('/api/users/:userId/apikey', (req, res) => {
    const { apiKey, provider } = req.body;
    db.run(`UPDATE users SET api_key = ?, api_provider = ? WHERE id = ?`, [apiKey, provider || 'openai', req.params.userId]);
    saveDB();
    res.json({ success: true });
});

app.get('/api/users/:userId/apikey', (req, res) => {
    const result = db.exec(`SELECT api_key, api_provider FROM users WHERE id = ?`, [req.params.userId]);
    if (result.length === 0 || result[0].values.length === 0) return res.status(404).json({ error: 'User not found' });
    const row = result[0].values[0];
    res.json({ hasKey: !!row[0], provider: row[1] });
});

// ── CVs ──
app.post('/api/cvs/upload', upload.single('file'), async (req, res) => {
    try {
        const { userId, title } = req.body;
        let text = req.body.text || '';

        if (req.file) {
            if (req.file.mimetype === 'application/pdf') {
                const parsed = await pdfParse(req.file.buffer);
                text = parsed.text;
            } else {
                text = req.file.buffer.toString('utf-8');
            }
        }

        if (!text.trim()) return res.status(400).json({ error: 'No CV content found' });

        const id = uuidv4();
        db.run(`INSERT INTO cvs (id, user_id, title, original_text, file_name) VALUES (?, ?, ?, ?, ?)`,
            [id, userId, title || 'My CV', text, req.file?.originalname || null]);
        saveDB();
        res.json({ id, title: title || 'My CV', text, fileName: req.file?.originalname });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/cvs/:userId', (req, res) => {
    const result = db.exec(`SELECT id, title, file_name, created_at, updated_at FROM cvs WHERE user_id = ? ORDER BY updated_at DESC`, [req.params.userId]);
    if (result.length === 0) return res.json([]);
    const cols = result[0].columns;
    const rows = result[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    res.json(rows);
});

app.get('/api/cvs/detail/:cvId', (req, res) => {
    const result = db.exec(`SELECT * FROM cvs WHERE id = ?`, [req.params.cvId]);
    if (result.length === 0 || result[0].values.length === 0) return res.status(404).json({ error: 'CV not found' });
    const cols = result[0].columns;
    const row = Object.fromEntries(cols.map((c, i) => [c, result[0].values[0][i]]));
    res.json(row);
});

app.put('/api/cvs/:cvId', (req, res) => {
    const { improved_text } = req.body;
    db.run(`UPDATE cvs SET improved_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [improved_text, req.params.cvId]);
    saveDB();
    res.json({ success: true });
});

app.delete('/api/cvs/:cvId', (req, res) => {
    db.run(`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE cv_id = ?)`, [req.params.cvId]);
    db.run(`DELETE FROM sessions WHERE cv_id = ?`, [req.params.cvId]);
    db.run(`DELETE FROM cvs WHERE id = ?`, [req.params.cvId]);
    saveDB();
    res.json({ success: true });
});

// ── SESSIONS ──
app.post('/api/sessions', (req, res) => {
    const { userId, cvId, title } = req.body;
    const id = uuidv4();
    db.run(`INSERT INTO sessions (id, user_id, cv_id, title) VALUES (?, ?, ?, ?)`,
        [id, userId, cvId || null, title || 'New Chat']);
    saveDB();
    res.json({ id, title: title || 'New Chat' });
});

app.get('/api/sessions/:userId', (req, res) => {
    const result = db.exec(`SELECT s.id, s.title, s.cv_id, s.created_at, s.updated_at, c.title as cv_title
        FROM sessions s LEFT JOIN cvs c ON s.cv_id = c.id
        WHERE s.user_id = ? ORDER BY s.updated_at DESC`, [req.params.userId]);
    if (result.length === 0) return res.json([]);
    const cols = result[0].columns;
    res.json(result[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))));
});

app.get('/api/sessions/messages/:sessionId', (req, res) => {
    const result = db.exec(`SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC`, [req.params.sessionId]);
    if (result.length === 0) return res.json([]);
    const cols = result[0].columns;
    res.json(result[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))));
});

app.delete('/api/sessions/:sessionId', (req, res) => {
    db.run(`DELETE FROM messages WHERE session_id = ?`, [req.params.sessionId]);
    db.run(`DELETE FROM sessions WHERE id = ?`, [req.params.sessionId]);
    saveDB();
    res.json({ success: true });
});

// ── CHAT (AI) ──
app.post('/api/chat', async (req, res) => {
    const { userId, sessionId, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    // Get user API key
    const userResult = db.exec(`SELECT api_key, api_provider FROM users WHERE id = ?`, [userId]);
    if (userResult.length === 0 || userResult[0].values.length === 0) return res.status(404).json({ error: 'User not found' });
    const [apiKey, provider] = userResult[0].values[0];
    if (!apiKey) return res.status(400).json({ error: 'Please set your API key in Settings first' });

    // Get CV text if session is linked
    let cvText = '';
    const sessResult = db.exec(`SELECT cv_id FROM sessions WHERE id = ?`, [sessionId]);
    if (sessResult.length > 0 && sessResult[0].values[0][0]) {
        const cvResult = db.exec(`SELECT original_text, improved_text FROM cvs WHERE id = ?`, [sessResult[0].values[0][0]]);
        if (cvResult.length > 0) {
            cvText = cvResult[0].values[0][1] || cvResult[0].values[0][0]; // prefer improved
        }
    }

    // Get chat history
    const histResult = db.exec(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC`, [sessionId]);
    const history = histResult.length > 0 ? histResult[0].values.map(r => ({ role: r[0], content: r[1] })) : [];

    // Save user message
    db.run(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', ?)`, [uuidv4(), sessionId, message]);
    db.run(`UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [sessionId]);

    const systemMsg = `You are an expert CV/resume consultant and career coach. You help users improve their CVs to land more interviews. Be specific, actionable, and professional. When suggesting changes, show the improved text clearly formatted.${cvText ? '\n\nHere is the user\'s current CV:\n' + cvText : '\n\nThe user has not uploaded a CV yet. Ask them to upload one first.'}`;

    try {
        let aiResponse;
        if (provider === 'openai') {
            const body = {
                model: 'gpt-4o-mini',
                messages: [{ role: 'system', content: systemMsg }, ...history, { role: 'user', content: message }],
                max_tokens: 2000
            };
            const result = await aiRequest('openai', apiKey, body);
            aiResponse = result.choices[0].message.content;
        } else {
            const body = {
                model: 'claude-sonnet-4-20250514',
                system: systemMsg,
                messages: [...history, { role: 'user', content: message }],
                max_tokens: 2000
            };
            const result = await aiRequest('anthropic', apiKey, body);
            aiResponse = result.content[0].text;
        }

        // Save assistant message
        db.run(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'assistant', ?)`, [uuidv4(), sessionId, aiResponse]);
        saveDB();

        res.json({ response: aiResponse });
    } catch (err) {
        saveDB();
        res.status(500).json({ error: err.message });
    }
});

// ── GENERATE COVER LETTER / MESSAGE ──
app.post('/api/generate', async (req, res) => {
    const { userId, jobDescription, type, cvId } = req.body;
    if (!jobDescription) return res.status(400).json({ error: 'Job description is required' });

    const userResult = db.exec(`SELECT api_key, api_provider FROM users WHERE id = ?`, [userId]);
    if (userResult.length === 0 || userResult[0].values.length === 0) return res.status(404).json({ error: 'User not found' });
    const [apiKey, provider] = userResult[0].values[0];
    if (!apiKey) return res.status(400).json({ error: 'Please set your API key in Settings first' });

    let cvText = '';
    if (cvId) {
        const cvResult = db.exec(`SELECT original_text, improved_text FROM cvs WHERE id = ?`, [cvId]);
        if (cvResult.length > 0) cvText = cvResult[0].values[0][1] || cvResult[0].values[0][0];
    }

    // Get settings
    const settResult = db.exec(`SELECT target_role, location, experience_level, industry FROM settings WHERE user_id = ?`, [userId]);
    let prefs = {};
    if (settResult.length > 0) {
        const cols = settResult[0].columns;
        prefs = Object.fromEntries(cols.map((c, i) => [c, settResult[0].values[0][i]]));
    }

    const prompt = type === 'linkedin'
        ? `Write a short, professional LinkedIn message (under 200 words) for this job. Be personable. Based on CV:\n\n${cvText || 'No CV provided.'}\n\nJob:\n${jobDescription}\n\n${prefs.target_role ? 'Target: ' + prefs.target_role : ''} ${prefs.location ? 'Location: ' + prefs.location : ''}`
        : `Write a professional cover letter (250-350 words) for this job. Based on CV:\n\n${cvText || 'No CV provided.'}\n\nJob:\n${jobDescription}\n\n${prefs.target_role ? 'Target: ' + prefs.target_role : ''} ${prefs.location ? 'Location: ' + prefs.location : ''}`;

    try {
        let aiResponse;
        if (provider === 'openai') {
            const body = {
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'You are an expert career coach. Write compelling, tailored application messages.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 1500
            };
            const result = await aiRequest('openai', apiKey, body);
            aiResponse = result.choices[0].message.content;
        } else {
            const body = {
                model: 'claude-sonnet-4-20250514',
                system: 'You are an expert career coach. Write compelling, tailored application messages.',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1500
            };
            const result = await aiRequest('anthropic', apiKey, body);
            aiResponse = result.content[0].text;
        }
        res.json({ text: aiResponse });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── APPLICATIONS TRACKER ──
app.get('/api/applications/:userId', (req, res) => {
    const result = db.exec(`SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId]);
    if (result.length === 0) return res.json([]);
    const cols = result[0].columns;
    res.json(result[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))));
});

app.post('/api/applications', (req, res) => {
    const { userId, company, position, status, dateApplied, notes, jobUrl, coverLetter } = req.body;
    const id = uuidv4();
    db.run(`INSERT INTO applications (id, user_id, company, position, status, date_applied, notes, job_url, cover_letter)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, company, position, status || 'applied', dateApplied, notes, jobUrl, coverLetter]);
    saveDB();
    res.json({ id, company, position, status: status || 'applied', date_applied: dateApplied, notes });
});

app.put('/api/applications/:appId', (req, res) => {
    const { company, position, status, dateApplied, notes, jobUrl, coverLetter } = req.body;
    db.run(`UPDATE applications SET company=?, position=?, status=?, date_applied=?, notes=?, job_url=?, cover_letter=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [company, position, status, dateApplied, notes, jobUrl, coverLetter, req.params.appId]);
    saveDB();
    res.json({ success: true });
});

app.delete('/api/applications/:appId', (req, res) => {
    db.run(`DELETE FROM applications WHERE id = ?`, [req.params.appId]);
    saveDB();
    res.json({ success: true });
});

// ── SETTINGS ──
app.get('/api/settings/:userId', (req, res) => {
    const result = db.exec(`SELECT * FROM settings WHERE user_id = ?`, [req.params.userId]);
    if (result.length === 0) return res.json({});
    const cols = result[0].columns;
    res.json(Object.fromEntries(cols.map((c, i) => [c, result[0].values[0][i]])));
});

app.post('/api/settings/:userId', (req, res) => {
    const { targetRole, location, experienceLevel, industry } = req.body;
    const existing = db.exec(`SELECT user_id FROM settings WHERE user_id = ?`, [req.params.userId]);
    if (existing.length > 0 && existing[0].values.length > 0) {
        db.run(`UPDATE settings SET target_role=?, location=?, experience_level=?, industry=? WHERE user_id=?`,
            [targetRole, location, experienceLevel, industry, req.params.userId]);
    } else {
        db.run(`INSERT INTO settings (user_id, target_role, location, experience_level, industry) VALUES (?, ?, ?, ?, ?)`,
            [req.params.userId, targetRole, location, experienceLevel, industry]);
    }
    saveDB();
    res.json({ success: true });
});

// ── START ──
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`\n  CVBoost is running at http://localhost:${PORT}\n`);
    });
});
