require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcrypt');
const axios    = require('axios');
const rateLimit = require('express-rate-limit');
const cors     = require('cors');
const path     = require('path');
const sqlite3  = require('sqlite3').verbose();
const fs       = require('fs');

const app = express();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const OWNER   = '@sahilxalone';
const CHANNEL = '@OSINTNXERA';
const MASTER_KEYS = {
    ftosint  : 'sahil-new',
    mistral  : 'FVKec5Xqa2ORzSoBrqi21nRbIM6rFk2q',
    subhxco  : 'subh-key',
    ayaanmods: 'ayaan-key'
};

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(path.join(dataDir, 'api_keys.db'));

// Promisified helpers — used everywhere instead of callbacks
const dbGet = (sql, p = []) => new Promise((ok, fail) => db.get(sql, p, (e, r) => e ? fail(e) : ok(r)));
const dbAll = (sql, p = []) => new Promise((ok, fail) => db.all(sql, p, (e, r) => e ? fail(e) : ok(r)));
const dbRun = (sql, p = []) => new Promise((ok, fail) => db.run(sql, p, function(e) { e ? fail(e) : ok(this); }));

// ─── DB INIT ──────────────────────────────────────────────────────────────────
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT UNIQUE,
        password   TEXT,
        role       TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS api_keys (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        key                  TEXT UNIQUE,
        name                 TEXT,
        owner_username       TEXT,
        owner_channel        TEXT,
        created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at           DATETIME,
        hits                 INTEGER DEFAULT 0,
        status               TEXT DEFAULT 'active',
        unlimited_hits       INTEGER DEFAULT 0,
        allowed_apis         TEXT DEFAULT '["all"]',
        is_custom            INTEGER DEFAULT 0,
        rate_limit_enabled   INTEGER DEFAULT 1,
        rate_limit_per_day   INTEGER DEFAULT 100,
        rate_limit_per_minute INTEGER DEFAULT 5,
        key_note             TEXT DEFAULT '',
        note_enabled         INTEGER DEFAULT 0,
        last_updated         DATETIME,
        api_enabled          INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS rate_limit_tracking (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key          TEXT,
        date             TEXT,
        minute_timestamp INTEGER,
        requests         INTEGER DEFAULT 0,
        UNIQUE(api_key, date, minute_timestamp)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS analytics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key       TEXT,
        endpoint      TEXT,
        status_code   INTEGER,
        ip_address    TEXT,
        response_time INTEGER,
        date          DATE DEFAULT CURRENT_DATE,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_calls (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        date    TEXT,
        calls   INTEGER DEFAULT 0,
        UNIQUE(api_key, date)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS available_apis (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT,
        display_name   TEXT,
        endpoint       TEXT,
        required_params  TEXT,
        example_params   TEXT,
        description    TEXT,
        is_active      INTEGER DEFAULT 1,
        custom_message TEXT DEFAULT 'API is currently turned off.'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS login_history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT,
        role       TEXT DEFAULT 'unknown',
        ip_address TEXT,
        user_agent TEXT,
        status     TEXT DEFAULT 'success',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        id                  INTEGER PRIMARY KEY,
        maintenance_message TEXT DEFAULT 'API is currently under maintenance.'
    )`);

    // Safe migrations — errors silently ignored (column already exists)
    db.run(`ALTER TABLE available_apis ADD COLUMN custom_message TEXT DEFAULT 'API is currently turned off.'`, () => {});
    db.run(`ALTER TABLE analytics ADD COLUMN response_time INTEGER`, () => {});
    db.run(`ALTER TABLE analytics ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP`, () => {});

    // Seed defaults
    db.get(`SELECT id FROM settings WHERE id = 1`, [], (e, r) => {
        if (!r) db.run(`INSERT INTO settings (id, maintenance_message) VALUES (1, 'API is currently under maintenance.')`);
    });
    db.get(`SELECT id FROM users WHERE username = 'main'`, [], (e, r) => {
        if (!r) db.run(`INSERT INTO users (username,password,role,created_by) VALUES (?,?,?,?)`,
            ['main', bcrypt.hashSync('sahil', 10), 'head_admin', 'system']);
    });
    db.get(`SELECT id FROM users WHERE username = 'sahil'`, [], (e, r) => {
        if (!r) db.run(`INSERT INTO users (username,password,role,created_by) VALUES (?,?,?,?)`,
            ['sahil', bcrypt.hashSync('sexy', 10), 'admin', 'main']);
    });
    db.get(`SELECT COUNT(*) as c FROM available_apis`, [], (e, r) => {
        if (r && r.c === 0) {
            const APIs = [
                ['leakpro',      '🔓 Leak Pro',           '/api/leakpro',      '{"number":""}',   '{"number":"919876543210"}', 'LEAK pro information'],
                ['vehicle-info', '🚗 Vehicle Info',        '/api/vehicle-info', '{"vehicle":""}',  '{"vehicle":"UP42BB2572"}',  'Vehicle challan/info'],
                ['telegram-num', '📞 Telegram to Number',  '/api/telegram-num', '{"term":""}',     '{"term":"7577179320"}',     'Number from Telegram ID'],
                ['family-info',  '👨‍👩‍👧‍👦 Family Info',       '/api/family-info',  '{"q":""}',        '{"q":"123456789012"}',      'Family information lookup'],
                ['number-info',  '📱 Number Info',         '/api/number-info',  '{"q":""}',        '{"q":"9876543321"}',        'Complete number information'],
                ['num-newinfo',  '🔍 Number New Info',     '/api/num-newinfo',  '{"q":""}',        '{"q":"1234597890"}',        'Advanced number information'],
                ['email-info',   '📧 Email Info',          '/api/email-info',   '{"q":""}',        '{"q":"test@email.com"}',    'Email address information'],
                ['family',       '👨‍👩‍👧‍👦 Family Tree',        '/api/family',       '{"term":""}',     '{"term":"979607168114"}',   'Family relationship lookup'],
                ['num-india',    '🇮🇳 Indian Number',       '/api/num-india',    '{"num":""}',      '{"num":"9876543210"}',      'Indian mobile number details'],
                ['num-pak',      '🇵🇰 Pakistani Number',    '/api/num-pak',      '{"number":""}',   '{"number":"03001234567"}',  'Pakistani mobile number'],
                ['bank',         '🏦 Bank IFSC',           '/api/bank',         '{"ifsc":""}',     '{"ifsc":"SBIN0001234"}',    'Bank branch details'],
                ['pan',          '📄 PAN Card',            '/api/pan',          '{"pan":""}',      '{"pan":"AXDPR2606K"}',      'PAN card details'],
                ['rc',           '📋 RC Details',          '/api/rc',           '{"owner":""}',    '{"owner":"HR26EV0001"}',    'Registration certificate'],
                ['ip',           '🌐 IP Geolocation',      '/api/ip',           '{"ip":""}',       '{"ip":"8.8.8.8"}',          'IP address location'],
                ['pincode',      '📍 Pincode Info',        '/api/pincode',      '{"pin":""}',      '{"pin":"110001"}',          'Area details from pincode'],
                ['git',          '🐙 GitHub User',         '/api/git',          '{"username":""}', '{"username":"octocat"}',    'GitHub profile info'],
                ['bgmi',         '🎮 BGMI Player',         '/api/bgmi',         '{"uid":""}',      '{"uid":"5121439477"}',      'BGMI player stats'],
                ['ff',           '🔫 FreeFire ID',         '/api/ff',           '{"uid":""}',      '{"uid":"123456789"}',       'FreeFire player info'],
                ['ai-image',     '🎨 AI Image Gen',        '/api/ai-image',     '{"prompt":""}',   '{"prompt":"cyberpunk cat"}','Generate AI images'],
                ['insta',        '📸 Instagram Info',      '/api/insta',        '{"username":""}', '{"username":"instagram"}',  'Instagram profile'],
                ['leak',         '🔍 Leak Info',           '/api/leak',         '{"number":""}',   '{"number":"919876543210"}', 'Complete phone info'],
                ['mistral',      '🤖 Mistral AI',          '/api/mistral',      '{"message":""}',  '{"message":"What is AI?"}', 'Chat with Mistral AI'],
                ['veh-to-num',   '🚗 Vehicle to Number',   '/api/veh-to-num',   '{"term":""}',     '{"term":"UP50P5434"}',      'Vehicle to mobile number']
            ];
            APIs.forEach(a => db.run(
                `INSERT INTO available_apis (name,display_name,endpoint,required_params,example_params,description,is_active,custom_message)
                 VALUES (?,?,?,?,?,?,1,'API is currently turned off.')`, a
            ));
        }
    });
});

// ─── EXPRESS SETUP ────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(cors());
app.use(session({
    secret: 'osint_secret_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: req => req.query.key || req.ip,
    handler: (req, res) => res.json({ error: 'Global rate limit exceeded', contact: OWNER })
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};
const requireHeadAdmin = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'head_admin')
        return res.status(403).json({ error: 'Access denied' });
    next();
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const getParam = (p, ...keys) => {
    for (const k of keys)
        if (p[k] !== undefined && p[k] !== null && p[k] !== '') return encodeURIComponent(p[k]);
    return '';
};

const parseParam = (raw) => {
    let params = {}, examples = {};
    try { params   = JSON.parse(raw || '{}'); } catch(_) {}
    return params;
};

const formatApis = (apis) => apis.map(api => {
    const params = parseParam(api.required_params);
    return { ...api, param_name: Object.keys(params)[0] || 'param' };
});

// ─── API PROXY MAP ────────────────────────────────────────────────────────────
const apiProxyMap = {
    'leakpro':      p => `https://raxxosint.onrender.com/leakosint?key=Customer&quiry=${getParam(p,'number','query','q','num','quiry','term')}`,
    'vehicle-info': p => `https://leakapi.dpdns.org/vehicle-info?registration_number=${getParam(p,'vehicle','registration_number','q','term','query')}`,
    'telegram-num': p => `https://tg-to-num-ten.vercel.app/tg?key=sahil_X&num=${getParam(p,'term','id','username','num','query','q')}`,
    'family-info':  p => `https://osint.invalidayushh.workers.dev/adhar?key=Sahil&q=${getParam(p,'q','term','id','query','number')}`,
    'number-info':  p => `https://osint.invalidayushh.workers.dev/num?key=Sahil&q=${getParam(p,'q','number','num','query','term')}`,
    'num-newinfo':  p => `https://leakapi.dpdns.org/search?q=${getParam(p,'q','number','num','query','term')}`,
    'email-info':   p => `https://osint.invalidayushh.workers.dev/email?key=Sahil&q=${getParam(p,'q','email','query')}`,
    'insta':        p => `https://osint.invalidayushh.workers.dev/insta?key=Sahil&q=${getParam(p,'username','q','query')}`,
    'vehicle':      p => `https://leakapi.dpdns.org/api/vehicle?vehicle=${getParam(p,'vehicle','q','term','query')}`,
    'family':       p => `https://ayaanmods.site/family.php?key=${MASTER_KEYS.subhxco}&term=${getParam(p,'term','q','query','number')}`,
    'num-india':    p => `https://ft-osint-api.duckdns.org/api/number?key=${MASTER_KEYS.ftosint}&num=${getParam(p,'num','number','q','query')}`,
    'num-pak':      p => `https://ft-osint-api.duckdns.org/api/pk?key=${MASTER_KEYS.ftosint}&number=${getParam(p,'number','num','q','query')}`,
    'bank':         p => `https://ft-osint-api.duckdns.org/api/ifsc?key=${MASTER_KEYS.ftosint}&ifsc=${getParam(p,'ifsc','q','query')}`,
    'pan':          p => `https://ft-osint-api.duckdns.org/api/pan?key=${MASTER_KEYS.ftosint}&pan=${getParam(p,'pan','q','query')}`,
    'rc':           p => `https://leakapi.dpdns.org/rc?registration_number=${getParam(p,'owner','vehicle','q','query')}`,
    'ip':           p => `https://ft-osint-api.duckdns.org/api/ip?key=${MASTER_KEYS.ftosint}&ip=${getParam(p,'ip','q','query')}`,
    'pincode':      p => `https://ft-osint-api.duckdns.org/api/pincode?key=${MASTER_KEYS.ftosint}&pin=${getParam(p,'pin','q','query')}`,
    'git':          p => `https://ft-osint-api.duckdns.org/api/git?key=${MASTER_KEYS.ftosint}&username=${getParam(p,'username','q','query')}`,
    'bgmi':         p => `https://ft-osint-api.duckdns.org/api/bgmi?key=${MASTER_KEYS.ftosint}&uid=${getParam(p,'uid','q','query')}`,
    'ff':           p => `https://ft-osint-api.duckdns.org/api/ff?key=${MASTER_KEYS.ftosint}&uid=${getParam(p,'uid','q','query')}`,
    'ai-image':     p => `https://ayaanmods.site/aiimage.php?key=${MASTER_KEYS.ayaanmods}&prompt=${getParam(p,'prompt','q','query')}`,
    'leak':         p => `https://leakapi.dpdns.org/chain?q=${getParam(p,'number','query','q','num','term')}`,
    'veh-to-num':   p => `https://vehicleinfo.noobgamingv40.workers.dev/fetch?vehicle=${getParam(p,'vehicle','term','q','query')}`,
    'mistral': async (p, res, keyData, rateLimitInfo) => {
        const message = decodeURIComponent(getParam(p, 'message', 'q', 'query', 'prompt'));
        if (!message) return res.status(400).json({ error: 'message param required', contact: OWNER });
        const r = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: 'mistral-small-latest',
            messages: [{ role: 'user', content: message }],
            max_tokens: 1024
        }, {
            headers: { Authorization: `Bearer ${MASTER_KEYS.mistral}`, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        const out = { success: true, reply: r.data.choices?.[0]?.message?.content || '', owner: OWNER, channel: CHANNEL };
        if (Object.keys(rateLimitInfo).length) out.rate_limit = rateLimitInfo;
        if ((keyData.note_enabled == 1) && keyData.key_note) out.key_note = keyData.key_note;
        return res.json(out);
    }
};

// ─── RESPONSE CLEANER ─────────────────────────────────────────────────────────
const REMOVE_FIELDS = new Set([
    'owner','OWNER','channel','CHANNEL','telegram','contact','instagram','twitter',
    'fb','facebook','website','github','created_by','createdBy','owner_username',
    'owner_channel','credit','Credits','Credit','Source','source','provider','Provider',
    'api_source','API_Source','developer','Developer','dev','Dev','invalidayushh',
    'ftgamerv2','ftgamer2','@invalidayushh','@ftgamerv2','@ftgamer2','InvalidAyush',
    '@InvalidAyush','invalidayush','@invalidayush','DM TO BUY ACCESS','xtradeep',
    'Kon_Hu_Mai','support','@raxusss','raxusss','Raxusss','Support','help','Help'
]);
const REMOVE_STRINGS = ['@raxusss','raxusss','InvalidAyush','@InvalidAyush','invalidayush','ftgamerv2','ftgamer2','@ftgamerv2','@ftgamer2'];

function cleanResponse(data) {
    if (!data || typeof data !== 'object') return data;
    const obj = JSON.parse(JSON.stringify(data));
    function clean(o) {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
            if (REMOVE_FIELDS.has(k) || REMOVE_FIELDS.has(k.toLowerCase())) { delete o[k]; continue; }
            if (typeof o[k] === 'string' && REMOVE_STRINGS.some(s => o[k].includes(s))) { delete o[k]; continue; }
            if (typeof o[k] === 'object') clean(o[k]);
        }
    }
    clean(obj);
    obj.owner   = OWNER;
    obj.channel = CHANNEL;
    return obj;
}

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
    try {
        const [keys, apis] = await Promise.all([
            dbAll('SELECT hits FROM api_keys'),
            dbAll('SELECT id FROM available_apis')
        ]);
        res.render('index', {
            user      : req.session.user || null,
            totalApis : apis.length,
            totalKeys : keys.length,
            totalHits : keys.reduce((s, k) => s + (k.hits || 0), 0),
            owner     : OWNER,
            channel   : CHANNEL
        });
    } catch (err) {
        console.error('Index error:', err);
        res.status(500).send('Database error: ' + err.message);
    }
});

app.get('/endpoints', async (req, res) => {
    try {
        const apis = await dbAll('SELECT * FROM available_apis WHERE is_active = 1');
        const formatted = apis.map(api => {
            let params = {}, examples = {};
            try { params   = JSON.parse(api.required_params || '{}'); } catch(_) {}
            try { examples = JSON.parse(api.example_params  || '{}'); } catch(_) {}
            const pName = Object.keys(params)[0] || 'param';
            return { ...api, param_name: pName, param_example: examples[pName] || 'value', full_url: api.endpoint };
        });
        res.render('endpoints', {
            apis: formatted, baseUrl: req.protocol + '://' + req.get('host'),
            owner: OWNER, channel: CHANNEL, user: req.session.user || null
        });
    } catch (err) {
        console.error('Endpoints error:', err);
        res.status(500).send('Database error: ' + err.message);
    }
});

app.get('/docs', async (req, res) => {
    try {
        const apis = await dbAll('SELECT * FROM available_apis WHERE is_active = 1');
        const base = req.protocol + '://' + req.get('host');
        const formatted = apis.map(api => {
            let params = {}, examples = {};
            try { params   = JSON.parse(api.required_params || '{}'); } catch(_) {}
            try { examples = JSON.parse(api.example_params  || '{}'); } catch(_) {}
            const pName = Object.keys(params)[0] || 'query';
            const pVal  = examples[pName] || 'sample_value';
            return { ...api, param_name: pName, param_example: pVal,
                full_example_url: `${base}${api.endpoint}?key=YOUR_API_KEY&${pName}=${pVal}` };
        });
        res.render('docs', {
            apis: formatted, baseUrl: base,
            owner: OWNER, channel: CHANNEL, user: req.session.user || null
        });
    } catch (err) {
        console.error('Docs error:', err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.render('login', { error: req.query.error || null }));

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const ip = req.ip || '';
    const ua = req.headers['user-agent'] || '';
    const log = (u, role, status) =>
        dbRun(`INSERT INTO login_history (username,role,ip_address,user_agent,status) VALUES (?,?,?,?,?)`,
            [u, role || 'unknown', ip, ua, status]).catch(() => {});

    if (!username || !password) {
        await log(username || null, null, 'failed_missing');
        return res.redirect('/login?error=missing');
    }
    try {
        const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            await log(username, null, 'failed_invalid');
            return res.redirect('/login?error=invalid');
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            await log(username, null, 'failed_wrong_pass');
            return res.redirect('/login?error=invalid');
        }
        req.session.user = { id: user.id, username: user.username, role: user.role };
        await log(user.username, user.role, 'success');
        res.redirect(user.role === 'head_admin' ? '/head-admin/dashboard' : '/admin/dashboard');
    } catch (err) {
        console.error('Login error:', err);
        res.redirect('/login?error=server');
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ─── ADMIN DASHBOARD ──────────────────────────────────────────────────────────
app.get('/admin/dashboard', requireAuth, async (req, res) => {
    try {
        const [keys, apis, settings, chartRows, dailyVolume, topEndpoints, recentActivity, reqStats] = await Promise.all([
            dbAll('SELECT * FROM api_keys ORDER BY created_at DESC'),
            dbAll('SELECT * FROM available_apis'),
            dbGet('SELECT * FROM settings WHERE id = 1'),
            dbAll('SELECT date, SUM(calls) as total_calls FROM daily_calls GROUP BY date ORDER BY date DESC LIMIT 7'),
            dbAll('SELECT date, SUM(calls) as total FROM daily_calls GROUP BY date ORDER BY date DESC LIMIT 7'),
            dbAll('SELECT endpoint, COUNT(*) as hits FROM analytics GROUP BY endpoint ORDER BY hits DESC LIMIT 5'),
            dbAll('SELECT endpoint, status_code, created_at FROM analytics ORDER BY id DESC LIMIT 8'),
            dbGet(`SELECT COUNT(*) as total,
                          SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success
                   FROM analytics`)
        ]);

        const activeApis = (apis || []).filter(a => a.is_active === 1).length;
        const totalReq   = reqStats ? (reqStats.total || 0) : 0;
        const successReq = reqStats ? (reqStats.success || 0) : 0;
        const successRate = totalReq > 0 ? ((successReq / totalReq) * 100).toFixed(1) : '100.0';

        const recent = (recentActivity || []).map(r => ({
            endpoint : '/api/' + r.endpoint,
            code     : r.status_code,
            ok       : r.status_code >= 200 && r.status_code < 300,
            time     : r.created_at
        }));

        res.render('dashboard', {
            keys         : keys || [],
            totalHits    : keys.reduce((s, k) => s + (k.hits || 0), 0),
            active       : keys.filter(k => k.status === 'active').length,
            apis         : formatApis(apis || []),
            chartData    : (chartRows || []).reverse(),
            dailyVolume  : (dailyVolume || []).reverse(),
            topEndpoints : topEndpoints || [],
            recentActivity : recent,
            health       : {
                uptime      : Math.floor(process.uptime()),
                activeApis  : activeApis,
                totalApis   : (apis || []).length,
                successRate : successRate,
                totalReq    : totalReq
            },
            user       : req.session.user,
            baseUrl    : req.protocol + '://' + req.get('host'),
            settings   : settings || { maintenance_message: 'API is currently under maintenance.' },
            owner      : OWNER,
            channel    : CHANNEL
        });
    } catch (err) {
        console.error('Admin dashboard error:', err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// ─── HEAD ADMIN DASHBOARD ─────────────────────────────────────────────────────
app.get('/head-admin/dashboard', requireHeadAdmin, async (req, res) => {
    try {
        const [keys, users, apis, settings, chartRows] = await Promise.all([
            dbAll('SELECT * FROM api_keys ORDER BY created_at DESC'),
            dbAll('SELECT * FROM users ORDER BY created_at DESC'),
            dbAll('SELECT * FROM available_apis'),
            dbGet('SELECT * FROM settings WHERE id = 1'),
            dbAll('SELECT date, SUM(calls) as total_calls FROM daily_calls GROUP BY date ORDER BY date DESC LIMIT 7'),
            dbAll('SELECT date, SUM(calls) as total FROM daily_calls GROUP BY date ORDER BY date DESC LIMIT 7'),
            dbAll('SELECT endpoint, COUNT(*) as hits FROM analytics GROUP BY endpoint ORDER BY hits DESC LIMIT 5')
        ]);
        res.render('head_admin_dashboard', {
            keys      : keys || [],
            users     : users || [],
            totalHits : keys.reduce((s, k) => s + (k.hits || 0), 0),
            apis      : formatApis(apis || []),
            chartData : (chartRows || []).reverse(),
            user      : req.session.user,
            baseUrl   : req.protocol + '://' + req.get('host'),
            settings  : settings || { maintenance_message: 'API is currently under maintenance.' },
            owner     : OWNER,
            channel   : CHANNEL
        });
    } catch (err) {
        console.error('Head admin dashboard error:', err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// ─── ANALYTICS PAGE ────────────────────────────────────────────────────────────
app.get('/admin/analytics', requireAuth, async (req, res) => {
    try {
        const epCount = await dbGet('SELECT COUNT(*) as c FROM available_apis');
        res.render('analytics', {
            totalEndpoints : epCount ? epCount.c : 0,
            user   : req.session.user,
            owner  : OWNER,
            channel: CHANNEL
        });
    } catch (err) {
        console.error('Analytics page error:', err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// ─── ANALYTICS DATA (JSON, live-refresh) ───────────────────────────────────────
app.get('/analytics/data', requireAuth, async (req, res) => {
    try {
        const [
            totalRow, successRow, errorRow, ipRow, latRow,
            endpointRows, statusRows, recentRows, hourlyRows, epCount
        ] = await Promise.all([
            dbGet('SELECT COUNT(*) as c FROM analytics'),
            dbGet('SELECT COUNT(*) as c FROM analytics WHERE status_code >= 200 AND status_code < 300'),
            dbGet('SELECT COUNT(*) as c FROM analytics WHERE status_code >= 400'),
            dbGet('SELECT COUNT(DISTINCT ip_address) as c FROM analytics'),
            dbGet('SELECT AVG(response_time) as avg FROM analytics WHERE response_time IS NOT NULL'),
            dbAll(`SELECT endpoint,
                          COUNT(*) as hits,
                          SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
                          SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error,
                          AVG(response_time) as avg_lat,
                          MIN(response_time) as min_lat,
                          MAX(response_time) as max_lat
                   FROM analytics GROUP BY endpoint ORDER BY hits DESC LIMIT 15`),
            dbAll('SELECT status_code as code, COUNT(*) as count FROM analytics GROUP BY status_code ORDER BY count DESC'),
            dbAll('SELECT endpoint, status_code, response_time, created_at FROM analytics ORDER BY id DESC LIMIT 30'),
            dbAll(`SELECT strftime('%H', created_at) as hour,
                          COUNT(*) as hits,
                          SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
                          SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error
                   FROM analytics
                   WHERE created_at >= datetime('now', '-24 hours')
                   GROUP BY hour ORDER BY hour`),
            dbGet('SELECT COUNT(*) as c FROM available_apis')
        ]);

        const totalRequests = totalRow ? totalRow.c : 0;
        const totalSuccess  = successRow ? successRow.c : 0;
        const totalError    = errorRow ? errorRow.c : 0;
        const uniqueIps     = ipRow ? ipRow.c : 0;
        const avgLatency    = latRow && latRow.avg ? Math.round(latRow.avg) : 0;
        const errorRate     = totalRequests > 0 ? ((totalError / totalRequests) * 100).toFixed(1) : '0.0';

        // Build 24-hour buckets (fill gaps with zeros)
        const hourMap = {};
        (hourlyRows || []).forEach(h => { hourMap[h.hour] = h; });
        const nowH = new Date().getHours();
        const hourlyChart = [];
        for (let i = 23; i >= 0; i--) {
            const hh = String((nowH - i + 24) % 24).padStart(2, '0');
            const row = hourMap[hh];
            hourlyChart.push({
                label   : hh + ':00',
                hits    : row ? row.hits : 0,
                success : row ? row.success : 0,
                error   : row ? row.error : 0
            });
        }

        const topEndpoints = (endpointRows || []).map(ep => ({
            name         : ep.endpoint,
            hits         : ep.hits,
            success      : ep.success,
            error        : ep.error,
            avgLatencyMs : ep.avg_lat ? Math.round(ep.avg_lat) : 0,
            minLatency   : ep.min_lat || 0,
            maxLatency   : ep.max_lat || 0,
            errorRate    : ep.hits > 0 ? ((ep.error / ep.hits) * 100).toFixed(1) : '0.0'
        }));

        const statusDist = (statusRows || []).map(s => ({ code: s.code || 0, count: s.count }));

        const recentRequests = (recentRows || []).map(r => ({
            time       : r.created_at,
            endpoint   : '/api/' + r.endpoint,
            statusCode : r.status_code,
            latencyMs  : r.response_time || 0,
            success    : r.status_code >= 200 && r.status_code < 300
        }));

        res.json({
            totalRequests, totalSuccess, totalError, errorRate,
            uniqueIps, avgLatency,
            uptime         : Math.floor(process.uptime()),
            totalEndpoints : epCount ? epCount.c : 0,
            hourlyChart, topEndpoints, statusDist, recentRequests
        });
    } catch (err) {
        console.error('Analytics data error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── LOGIN HISTORY ────────────────────────────────────────────────────────────
app.get('/admin/login-history', requireAuth, async (req, res) => {
    try {
        const [logs, topFailedIPs] = await Promise.all([
            dbAll('SELECT * FROM login_history ORDER BY created_at DESC LIMIT 200'),
            dbAll(`SELECT ip_address, COUNT(*) as attempts FROM login_history
                   WHERE status != 'success' GROUP BY ip_address ORDER BY attempts DESC LIMIT 10`)
        ]);
        res.render('login_history', {
            logs         : logs || [],
            successCount : (logs || []).filter(l => l.status === 'success').length,
            failCount    : (logs || []).filter(l => l.status !== 'success').length,
            topFailedIPs : topFailedIPs || [],
            user         : req.session.user,
            owner        : OWNER,
            channel      : CHANNEL
        });
    } catch (err) {
        console.error('Login history error:', err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// ─── KEY MANAGEMENT ───────────────────────────────────────────────────────────
app.post('/admin/generate-key', requireAuth, async (req, res) => {
    const {
        name, expiry, unlimited_hits, selected_apis, custom_key,
        rate_limit_per_day, rate_limit_per_minute, key_note,
        custom_expiry_date, custom_expiry_time
    } = req.body;
    const isCustomEnabled = req.body.enable_custom === 'on';

    if (isCustomEnabled && (!custom_key || !custom_key.trim())) {
        return res.status(400).send('❌ Please enter a custom key string.');
    }

    let expires_at = null;
    const now = new Date();
    if      (expiry === '3d')  expires_at = new Date(now.getTime() + 3  * 86400000);
    else if (expiry === '7d')  expires_at = new Date(now.getTime() + 7  * 86400000);
    else if (expiry === '30d') expires_at = new Date(now.getTime() + 30 * 86400000);
    else if (expiry === 'custom' && custom_expiry_date) {
        const d = new Date(`${custom_expiry_date}T${custom_expiry_time || '23:59'}`);
        if (!isNaN(d)) expires_at = d;
    }

    let allowedApisJson = '["all"]';
    if (selected_apis) {
        if (selected_apis === 'all' || (Array.isArray(selected_apis) && selected_apis.includes('all')))
            allowedApisJson = '["all"]';
        else
            allowedApisJson = JSON.stringify(Array.isArray(selected_apis) ? selected_apis : [selected_apis]);
    }

    const isUnlimited = ['true','on','1'].includes(String(unlimited_hits));
    const noteText    = (key_note || '').trim();
    const perDay      = isUnlimited ? 0 : (parseInt(rate_limit_per_day)    || 100);
    const perMin      = isUnlimited ? 0 : (parseInt(rate_limit_per_minute) || 0);

    const insert = async (apiKey, isCustom) => {
        await dbRun(
            `INSERT INTO api_keys
             (key,name,owner_username,owner_channel,expires_at,unlimited_hits,allowed_apis,
              status,is_custom,rate_limit_enabled,rate_limit_per_day,rate_limit_per_minute,
              key_note,note_enabled,last_updated,api_enabled)
             VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,1)`,
            [apiKey, name, OWNER, CHANNEL,
             expires_at ? expires_at.toISOString() : null,
             isUnlimited ? 1 : 0, allowedApisJson,
             isCustom ? 1 : 0,
             isUnlimited ? 0 : 1, perDay, perMin,
             noteText, noteText.length > 0 ? 1 : 0,
             new Date().toISOString()]
        );
        res.redirect('/admin/dashboard');
    };

    try {
        if (isCustomEnabled && custom_key && custom_key.trim()) {
            const apiKey = custom_key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
            if (apiKey.length < 3) return res.status(400).send('❌ Custom key must be at least 3 characters');
            const existing = await dbGet('SELECT key FROM api_keys WHERE key = ?', [apiKey]);
            if (existing) return res.status(400).send('❌ Key already exists: ' + apiKey);
            await insert(apiKey, true);
        } else {
            const apiKey = 'OSINT_' + Math.random().toString(36).substring(2, 18).toUpperCase();
            await insert(apiKey, false);
        }
    } catch (err) {
        console.error('Generate key error:', err);
        res.status(500).send('Database error: ' + err.message);
    }
});

app.post('/admin/edit-key', requireAuth, async (req, res) => {
    const {
        key_id, name, expiry, unlimited_hits,
        rate_limit_per_day, rate_limit_per_minute,
        key_note, status, selected_apis, api_enabled
    } = req.body;

    if (!key_id) return res.status(400).json({ success: false, error: 'Key ID required' });

    let expires_at = null;
    if (expiry && expiry !== 'keep' && expiry !== 'never') {
        const now = new Date();
        if      (expiry === '3d')  expires_at = new Date(now.getTime() + 3  * 86400000);
        else if (expiry === '7d')  expires_at = new Date(now.getTime() + 7  * 86400000);
        else if (expiry === '30d') expires_at = new Date(now.getTime() + 30 * 86400000);
    }

    let allowedApisJson = '["all"]';
    if (selected_apis) {
        if (selected_apis === 'all' || (Array.isArray(selected_apis) && selected_apis.includes('all')))
            allowedApisJson = '["all"]';
        else
            allowedApisJson = JSON.stringify(Array.isArray(selected_apis) ? selected_apis : [selected_apis]);
    }

    const isUnlimited = ['true','on','1',1].includes(unlimited_hits);
    const enabled     = !['false','0',0].includes(api_enabled) ? 1 : 0;
    const noteText    = (key_note || '').trim();
    const perDay      = isUnlimited ? 0 : (parseInt(rate_limit_per_day)    >= 0 ? parseInt(rate_limit_per_day)    : 100);
    const perMin      = isUnlimited ? 0 : (parseInt(rate_limit_per_minute) >= 0 ? parseInt(rate_limit_per_minute) : 0);
    const expiryIso   = expires_at ? expires_at.toISOString() : null;

    try {
        await dbRun(
            `UPDATE api_keys SET
               name = COALESCE(?,name),
               allowed_apis = ?,
               key_note = ?,
               note_enabled = ?,
               unlimited_hits = ?,
               rate_limit_enabled = ?,
               rate_limit_per_day = ?,
               rate_limit_per_minute = ?,
               status = COALESCE(?,status),
               api_enabled = ?,
               expires_at = CASE
                   WHEN ? = 'never' THEN NULL
                   WHEN ? = 'keep'  THEN expires_at
                   WHEN ? IS NOT NULL THEN ?
                   ELSE expires_at
               END,
               last_updated = ?
             WHERE id = ?`,
            [name || null, allowedApisJson, noteText, noteText.length > 0 ? 1 : 0,
             isUnlimited ? 1 : 0, isUnlimited ? 0 : 1, perDay, perMin,
             status || null, enabled,
             expiry, expiry, expiryIso, expiryIso,
             new Date().toISOString(), key_id]
        );
        res.json({ success: true, message: 'Key updated successfully' });
    } catch (err) {
        console.error('Edit key error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/admin/delete-key', requireAuth, async (req, res) => {
    if (!req.body.id) return res.status(400).send('Key ID required');
    try {
        await dbRun('DELETE FROM api_keys WHERE id = ?', [req.body.id]);
        res.redirect('/admin/dashboard');
    } catch (err) {
        res.status(500).send('Database error: ' + err.message);
    }
});

app.post('/admin/toggle-key-enabled', requireAuth, async (req, res) => {
    const { key_id, api_enabled } = req.body;
    if (!key_id) return res.status(400).json({ success: false, error: 'Key ID required' });
    const enabled = ['true','1',1,true].includes(api_enabled) ? 1 : 0;
    try {
        await dbRun('UPDATE api_keys SET api_enabled = ?, last_updated = ? WHERE id = ?',
            [enabled, new Date().toISOString(), key_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/admin/bulk-key-action', requireAuth, async (req, res) => {
    const { key_ids, action } = req.body;
    if (!key_ids || !Array.isArray(key_ids) || !key_ids.length)
        return res.status(400).json({ success: false, error: 'No keys selected' });
    const ph  = key_ids.map(() => '?').join(',');
    const sqls = {
        enable : `UPDATE api_keys SET api_enabled = 1 WHERE id IN (${ph})`,
        disable: `UPDATE api_keys SET api_enabled = 0 WHERE id IN (${ph})`,
        revoke : `UPDATE api_keys SET status = 'disabled' WHERE id IN (${ph})`,
        delete : `DELETE FROM api_keys WHERE id IN (${ph})`
    };
    if (!sqls[action]) return res.status(400).json({ success: false, error: 'Invalid action' });
    try {
        await dbRun(sqls[action], key_ids);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── API MANAGEMENT ───────────────────────────────────────────────────────────
app.post('/admin/toggle-api', requireAuth, async (req, res) => {
    const { api_id, is_active } = req.body;
    if (!api_id) return res.status(400).json({ error: 'API ID required' });
    try {
        await dbRun('UPDATE available_apis SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, api_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/update-api-status', requireAuth, async (req, res) => {
    const { api_id, is_active, custom_message } = req.body;
    if (!api_id) return res.status(400).json({ error: 'API ID required' });
    try {
        await dbRun('UPDATE available_apis SET is_active = ?, custom_message = ? WHERE id = ?',
            [is_active ? 1 : 0, custom_message || 'API is currently turned off.', api_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/update-api-name', requireAuth, async (req, res) => {
    const { api_id, display_name } = req.body;
    if (!api_id || !display_name) return res.status(400).json({ error: 'API ID and display name required' });
    try {
        await dbRun('UPDATE available_apis SET display_name = ? WHERE id = ?', [display_name, api_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/update-settings', requireAuth, async (req, res) => {
    const { maintenance_message } = req.body;
    if (!maintenance_message) return res.status(400).send('Maintenance message required');
    try {
        await dbRun('UPDATE settings SET maintenance_message = ? WHERE id = 1', [maintenance_message]);
        res.redirect('/admin/dashboard');
    } catch (err) { res.status(500).send('Database error: ' + err.message); }
});

// ─── HEAD ADMIN: USER MANAGEMENT ─────────────────────────────────────────────
app.post('/head-admin/create-user', requireHeadAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || !role)
        return res.status(400).json({ success: false, error: 'username, password, role required' });
    try {
        const hashed = await bcrypt.hash(password, 10);
        await dbRun(`INSERT INTO users (username,password,role,created_by) VALUES (?,?,?,?)`,
            [username, hashed, role, req.session.user.username]);
        res.json({ success: true });
    } catch (err) {
        if (err.message.includes('UNIQUE'))
            return res.status(400).json({ success: false, error: 'Username already exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/head-admin/delete-user', requireHeadAdmin, async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
    try {
        await dbRun('DELETE FROM users WHERE id = ? AND username != "main"', [user_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── MAIN API ENDPOINT ────────────────────────────────────────────────────────
app.all('/api/:endpoint', globalLimiter, async (req, res) => {
    const userKey  = req.query.key || req.body.key;
    const endpoint = req.params.endpoint;
    const reqStart = Date.now();
    const today    = new Date().toISOString().split('T')[0];

    try {
        if (!userKey)
            return res.status(401).json({ error: 'API key required', contact: OWNER });

        // Check API enabled status
        const targetApi = await dbGet(
            'SELECT * FROM available_apis WHERE name = ? OR endpoint = ?',
            [endpoint, `/api/${endpoint}`]
        );
        if (targetApi && targetApi.is_active === 0)
            return res.json({ status: false, message: targetApi.custom_message || 'This API is currently turned off.' });

        // Validate key
        const keyData = await dbGet('SELECT * FROM api_keys WHERE key = ?', [userKey]);
        if (!keyData)
            return res.status(403).json({ error: 'Invalid API key', contact: OWNER });
        if (keyData.api_enabled === 0)
            return res.status(403).json({ success: false, message: 'This API Key has been disabled by administrator.' });
        if (keyData.status !== 'active')
            return res.status(403).json({ error: `Key status is ${keyData.status}`, contact: OWNER });

        // Check allowed APIs
        try {
            const allowed = JSON.parse(keyData.allowed_apis || '["all"]');
            if (!allowed.includes('all') && !allowed.includes(endpoint))
                return res.status(403).json({ success: false, error: `Endpoint "${endpoint}" not allowed for this key.` });
        } catch(_) {}

        // Check expiry
        if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
            dbRun('UPDATE api_keys SET status = "expired" WHERE id = ?', [keyData.id]).catch(() => {});
            return res.status(403).json({ error: 'Key expired', contact: OWNER });
        }

        // ── Rate limiting ──────────────────────────────────────────────────────
        let rateLimitInfo = {};
        if (!keyData.unlimited_hits && keyData.rate_limit_enabled) {
            const perDay = parseInt(keyData.rate_limit_per_day)    || 100;
            const perMin = parseInt(keyData.rate_limit_per_minute)  || 0;
            const nowTs  = Math.floor(Date.now() / 60000);

            const dailyRow = await dbGet(
                'SELECT SUM(requests) as total FROM rate_limit_tracking WHERE api_key = ? AND date = ?',
                [userKey, today]
            );
            const dailyCount = dailyRow ? (dailyRow.total || 0) : 0;

            if (perDay > 0 && dailyCount >= perDay)
                return res.status(429).json({
                    success: false, error: `Daily limit exceeded (${perDay}/day)`,
                    rate_limit: { per_day: { limit: perDay, used: dailyCount, remaining: 0 } }, contact: OWNER
                });

            let minCount = 0;
            if (perMin > 0) {
                const minRow = await dbGet(
                    'SELECT requests FROM rate_limit_tracking WHERE api_key = ? AND minute_timestamp = ?',
                    [userKey, nowTs]
                );
                minCount = minRow ? minRow.requests : 0;
                if (minCount >= perMin)
                    return res.status(429).json({
                        success: false, error: `Per-minute limit exceeded (${perMin}/min)`,
                        rate_limit: {
                            per_minute: { limit: perMin, used: minCount, remaining: 0 },
                            per_day   : { limit: perDay, used: dailyCount, remaining: Math.max(0, perDay - dailyCount) }
                        }, contact: OWNER
                    });
            }

            dbRun(
                `INSERT INTO rate_limit_tracking (api_key,date,minute_timestamp,requests) VALUES (?,?,?,1)
                 ON CONFLICT(api_key,date,minute_timestamp) DO UPDATE SET requests = requests + 1`,
                [userKey, today, nowTs]
            ).catch(() => {});

            rateLimitInfo.per_day = { limit: perDay, used: dailyCount + 1, remaining: Math.max(0, perDay - dailyCount - 1) };
            if (perMin > 0)
                rateLimitInfo.per_minute = { limit: perMin, used: minCount + 1, remaining: Math.max(0, perMin - minCount - 1) };
        }

        // Track hits
        dbRun(`INSERT INTO daily_calls (api_key,date,calls) VALUES (?,?,1)
               ON CONFLICT(api_key,date) DO UPDATE SET calls = calls + 1`, [userKey, today]).catch(() => {});
        dbRun('UPDATE api_keys SET hits = hits + 1 WHERE id = ?', [keyData.id]).catch(() => {});

        const proxyFn = apiProxyMap[endpoint];
        if (!proxyFn)
            return res.status(404).json({ error: 'Unknown endpoint', contact: OWNER });

        const params = { ...req.query, ...req.body };

        // Mistral — handles its own response
        if (endpoint === 'mistral') {
            try { await proxyFn(params, res, keyData, rateLimitInfo); }
            catch (err) {
                console.error('Mistral error:', err);
                res.status(500).json({ error: 'Mistral request failed', details: err.message });
            }
            return;
        }

        // Standard proxy
        try {
            const targetUrl  = proxyFn(params);
            const upstream   = await axios.get(targetUrl, { timeout: 30000 });
            const responseMs = Date.now() - reqStart;
            let data         = cleanResponse(upstream.data);

            if (Object.keys(rateLimitInfo).length) data.rate_limit = rateLimitInfo;
            if (keyData.note_enabled == 1 && keyData.key_note) data.key_note = keyData.key_note;

            dbRun(`INSERT INTO analytics (api_key,endpoint,status_code,ip_address,response_time,date)
                   VALUES (?,?,?,?,?,?)`, [userKey, endpoint, upstream.status, req.ip, responseMs, today]).catch(() => {});

            res.json(data);
        } catch (err) {
            console.error('Proxy error:', err);
            dbRun(`INSERT INTO analytics (api_key,endpoint,status_code,ip_address,response_time,date)
                   VALUES (?,?,?,?,?,?)`, [userKey, endpoint, 500, req.ip, Date.now() - reqStart, today]).catch(() => {});
            res.status(500).json({ error: 'Upstream API failed', details: err.message });
        }

    } catch (err) {
        console.error('API handler error:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── ERROR HANDLER (must be last) ────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 OSINT API HUB — PORT ${PORT}`));
module.exports = app;
