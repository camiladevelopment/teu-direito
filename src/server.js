const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { db, slugify } = require('./database');
const { notifyThreshold } = require('./notification-service');
const SQLiteSessionStore = require('./sqlite-session-store');

const app = express();
const port = Number(process.env.PORT || 3000);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'data:']
    }
  }
}));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(session({
  name: 'teu-direito.sid',
  secret: process.env.SESSION_SECRET || 'desenvolvimento-local-altere-em-producao',
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 1000 * 60 * 60 * 12
  }
}));

const statusLabels = {
  WAITING_REPLY: 'Aguardando resposta',
  ANSWERED: 'Respondida',
  RESOLVED: 'Resolvida'
};

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date(`${value.replace(' ', 'T')}Z`));
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/minha-area';
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    setFlash(req, 'info', 'Entre na sua conta para continuar.');
    return res.redirect(`/entrar?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).render('message', {
        title: 'Acesso restrito',
        message: 'Sua conta não tem permissão para acessar esta área.'
      });
    }
    next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  next();
}

function csrfProtection(req, res, next) {
  if (req.method === 'POST' && req.body._csrf !== req.session.csrfToken) {
    return res.status(403).render('message', {
      title: 'Sessão expirada',
      message: 'Atualize a página e tente novamente.'
    });
  }
  next();
}

app.use(ensureCsrfToken);
app.use((req, res, next) => {
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = flash;
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.statusLabels = statusLabels;
  res.locals.formatDate = formatDate;
  res.locals.currentPath = req.path;
  next();
});
app.use(csrfProtection);

function referenceData() {
  return {
    municipalities: db.prepare('SELECT * FROM municipalities ORDER BY name').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY name').all()
  };
}

function listComplaints({ municipalityId, categoryId, status, query, companyId, limit = 50 } = {}) {
  const conditions = ['c.hidden = 0'];
  const params = [];
  if (municipalityId) {
    conditions.push('c.municipality_id = ?');
    params.push(municipalityId);
  }
  if (categoryId) {
    conditions.push('c.category_id = ?');
    params.push(categoryId);
  }
  if (status && statusLabels[status]) {
    conditions.push('c.status = ?');
    params.push(status);
  }
  if (query) {
    conditions.push('(c.title LIKE ? OR c.description LIKE ? OR company.name LIKE ?)');
    const like = `%${query}%`;
    params.push(like, like, like);
  }
  if (companyId) {
    conditions.push('cc.company_id = ?');
    params.push(companyId);
  }
  params.push(limit);

  return db.prepare(`
    SELECT c.*, m.name AS municipality_name, m.state, cat.name AS category_name,
      cat.icon AS category_icon, u.name AS author_name,
      COUNT(DISTINCT s.id) AS support_count,
      GROUP_CONCAT(DISTINCT company.name) AS company_names
    FROM complaints c
    JOIN municipalities m ON m.id = c.municipality_id
    JOIN categories cat ON cat.id = c.category_id
    JOIN users u ON u.id = c.author_id
    JOIN complaint_companies cc ON cc.complaint_id = c.id
    JOIN companies company ON company.id = cc.company_id
    LEFT JOIN supports s ON s.complaint_id = c.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY c.id
    ORDER BY c.created_at DESC
    LIMIT ?
  `).all(...params);
}

function uniqueCompanySlug(name) {
  const base = slugify(name) || 'entidade';
  let candidate = base;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM companies WHERE slug = ?').get(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

app.get('/', (req, res) => {
  const complaints = listComplaints({ limit: 6 });
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM complaints WHERE hidden = 0) AS complaints,
      (SELECT COUNT(*) FROM companies) AS companies,
      (SELECT COUNT(*) FROM supports) AS supports,
      (SELECT COUNT(*) FROM complaints WHERE status = 'RESOLVED' AND hidden = 0) AS resolved
  `).get();
  res.render('home', { complaints, stats, ...referenceData() });
});

app.get('/empresas', (req, res) => {
  const query = String(req.query.q || '').trim();
  const municipalityId = Number(req.query.municipio) || null;
  const conditions = [];
  const params = [];
  if (query) {
    conditions.push('company.name LIKE ?');
    params.push(`%${query}%`);
  }
  if (municipalityId) {
    conditions.push('company.municipality_id = ?');
    params.push(municipalityId);
  }
  const companies = db.prepare(`
    SELECT company.*, m.name AS municipality_name, m.state,
      COUNT(DISTINCT c.id) AS complaint_count,
      SUM(CASE WHEN c.status = 'RESOLVED' THEN 1 ELSE 0 END) AS resolved_count
    FROM companies company
    JOIN municipalities m ON m.id = company.municipality_id
    LEFT JOIN complaint_companies cc ON cc.company_id = company.id
    LEFT JOIN complaints c ON c.id = cc.complaint_id AND c.hidden = 0
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    GROUP BY company.id
    ORDER BY company.name
  `).all(...params);
  res.render('companies', {
    companies, query, selectedMunicipality: municipalityId, ...referenceData()
  });
});

app.get('/empresas/:slug', (req, res, next) => {
  const company = db.prepare(`
    SELECT company.*, m.name AS municipality_name, m.state,
      COUNT(DISTINCT c.id) AS complaint_count
    FROM companies company
    JOIN municipalities m ON m.id = company.municipality_id
    LEFT JOIN complaint_companies cc ON cc.company_id = company.id
    LEFT JOIN complaints c ON c.id = cc.complaint_id AND c.hidden = 0
    WHERE company.slug = ?
    GROUP BY company.id
  `).get(req.params.slug);
  if (!company) return next();
  const complaints = listComplaints({
    companyId: company.id,
    municipalityId: Number(req.query.municipio) || null,
    categoryId: Number(req.query.categoria) || null
  });
  res.render('company', {
    company,
    complaints,
    selectedMunicipality: Number(req.query.municipio) || null,
    selectedCategory: Number(req.query.categoria) || null,
    ...referenceData()
  });
});

app.get('/reclamacoes', (req, res) => {
  const filters = {
    query: String(req.query.q || '').trim(),
    municipalityId: Number(req.query.municipio) || null,
    categoryId: Number(req.query.categoria) || null,
    status: String(req.query.status || '')
  };
  res.render('complaints', {
    complaints: listComplaints(filters), filters, ...referenceData()
  });
});

app.get('/reclamacoes/nova', requireAuth, requireRole('WORKER'), (req, res) => {
  const companies = db.prepare(`
    SELECT company.*, m.name AS municipality_name, m.state
    FROM companies company JOIN municipalities m ON m.id = company.municipality_id
    ORDER BY company.name
  `).all();
  res.render('new-complaint', { companies, errors: [], values: {}, ...referenceData() });
});

app.post('/reclamacoes', requireAuth, requireRole('WORKER'), (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const municipalityId = Number(req.body.municipality_id);
  const categoryId = Number(req.body.category_id);
  const companyIds = [...new Set([]
    .concat(req.body.company_ids || [])
    .map(Number)
    .filter(Number.isInteger))];
  const errors = [];
  if (title.length < 8 || title.length > 140) errors.push('O título deve ter entre 8 e 140 caracteres.');
  if (description.length < 30 || description.length > 5000) errors.push('Descreva o problema usando entre 30 e 5.000 caracteres.');
  if (!db.prepare('SELECT 1 FROM municipalities WHERE id = ?').get(municipalityId)) errors.push('Selecione um município válido.');
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) errors.push('Selecione uma categoria válida.');
  const validCompanies = companyIds.length
    ? db.prepare(`SELECT id FROM companies WHERE id IN (${companyIds.map(() => '?').join(',')})`).all(...companyIds)
    : [];
  if (!validCompanies.length || validCompanies.length !== companyIds.length) errors.push('Selecione ao menos uma empresa ou órgão válido.');

  if (errors.length) {
    const companies = db.prepare(`
      SELECT company.*, m.name AS municipality_name, m.state
      FROM companies company JOIN municipalities m ON m.id = company.municipality_id
      ORDER BY company.name
    `).all();
    return res.status(422).render('new-complaint', {
      companies, errors,
      values: { title, description, municipality_id: municipalityId, category_id: categoryId, company_ids: companyIds },
      ...referenceData()
    });
  }

  const complaintId = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO complaints
        (author_id, municipality_id, category_id, title, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.session.user.id, municipalityId, categoryId, title, description);
    const id = Number(result.lastInsertRowid);
    const link = db.prepare(
      'INSERT INTO complaint_companies (complaint_id, company_id) VALUES (?, ?)'
    );
    for (const companyId of companyIds) link.run(id, companyId);
    return id;
  })();
  setFlash(req, 'success', 'Seu relato foi publicado e já está visível para a comunidade.');
  res.redirect(`/reclamacoes/${complaintId}`);
});

app.get('/reclamacoes/:id', (req, res, next) => {
  const complaint = db.prepare(`
    SELECT c.*, m.name AS municipality_name, m.state, cat.name AS category_name,
      cat.icon AS category_icon, u.name AS author_name,
      COUNT(DISTINCT s.id) AS support_count,
      SUM(CASE WHEN s.kind = 'AFFECTED' THEN 1 ELSE 0 END) AS affected_count
    FROM complaints c
    JOIN municipalities m ON m.id = c.municipality_id
    JOIN categories cat ON cat.id = c.category_id
    JOIN users u ON u.id = c.author_id
    LEFT JOIN supports s ON s.complaint_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(Number(req.params.id));
  if (!complaint) return next();
  if (complaint.hidden && req.session.user?.role !== 'MODERATOR' && req.session.user?.id !== complaint.author_id) {
    return res.status(404).render('message', {
      title: 'Conteúdo indisponível',
      message: 'Esta publicação não está disponível para visualização.'
    });
  }
  const companies = db.prepare(`
    SELECT company.*, m.name AS municipality_name, m.state
    FROM complaint_companies cc
    JOIN companies company ON company.id = cc.company_id
    JOIN municipalities m ON m.id = company.municipality_id
    WHERE cc.complaint_id = ?
    ORDER BY company.name
  `).all(complaint.id);
  const responses = db.prepare(`
    SELECT r.*, company.name AS company_name, company.slug AS company_slug,
      reply.id AS reply_id, reply.body AS reply_body, reply.created_at AS reply_created_at
    FROM responses r
    JOIN companies company ON company.id = r.company_id
    LEFT JOIN replies reply ON reply.response_id = r.id
    WHERE r.complaint_id = ?
    ORDER BY r.created_at
  `).all(complaint.id);
  const support = req.session.user
    ? db.prepare('SELECT * FROM supports WHERE complaint_id = ? AND user_id = ?')
      .get(complaint.id, req.session.user.id)
    : null;
  const supportStories = db.prepare(`
    SELECT s.kind, s.story, s.created_at, u.name
    FROM supports s
    JOIN users u ON u.id = s.user_id
    WHERE s.complaint_id = ? AND length(s.story) > 0
    ORDER BY s.created_at DESC
    LIMIT 20
  `).all(complaint.id);
  const canRespondCompanies = req.session.user?.role === 'COMPANY'
    ? db.prepare(`
      SELECT company.id, company.name
      FROM company_members cm
      JOIN companies company ON company.id = cm.company_id
      JOIN complaint_companies cc ON cc.company_id = company.id AND cc.complaint_id = ?
      LEFT JOIN responses r ON r.complaint_id = ? AND r.company_id = company.id
      WHERE cm.user_id = ? AND r.id IS NULL
    `).all(complaint.id, complaint.id, req.session.user.id)
    : [];
  const rights = db.prepare(`
    SELECT * FROM rights_articles WHERE category_id = ? ORDER BY title LIMIT 2
  `).all(complaint.category_id);
  res.render('complaint-detail', {
    complaint, companies, responses, support, supportStories, canRespondCompanies, rights
  });
});

app.post('/reclamacoes/:id/respostas', requireAuth, requireRole('COMPANY'), (req, res, next) => {
  const complaintId = Number(req.params.id);
  const companyId = Number(req.body.company_id);
  const body = String(req.body.body || '').trim();
  const allowed = db.prepare(`
    SELECT 1
    FROM company_members cm
    JOIN complaint_companies cc ON cc.company_id = cm.company_id
    JOIN complaints c ON c.id = cc.complaint_id
    WHERE cm.user_id = ? AND cm.company_id = ? AND cc.complaint_id = ? AND c.hidden = 0
  `).get(req.session.user.id, companyId, complaintId);
  if (!allowed) return next();
  if (body.length < 20 || body.length > 5000) {
    setFlash(req, 'error', 'A resposta deve ter entre 20 e 5.000 caracteres.');
    return res.redirect(`/reclamacoes/${complaintId}#responder`);
  }
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO responses (complaint_id, company_id, author_id, body)
        VALUES (?, ?, ?, ?)
      `).run(complaintId, companyId, req.session.user.id, body);
      db.prepare(`
        UPDATE complaints SET status = 'ANSWERED'
        WHERE id = ? AND status = 'WAITING_REPLY'
      `).run(complaintId);
    })();
    setFlash(req, 'success', 'Resposta publicada com transparência no histórico.');
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) {
      setFlash(req, 'error', 'Esta entidade já respondeu à reclamação.');
    } else {
      throw error;
    }
  }
  res.redirect(`/reclamacoes/${complaintId}#respostas`);
});

app.post('/reclamacoes/:id/replicas', requireAuth, requireRole('WORKER'), (req, res, next) => {
  const complaintId = Number(req.params.id);
  const responseId = Number(req.body.response_id);
  const body = String(req.body.body || '').trim();
  const response = db.prepare(`
    SELECT r.id FROM responses r
    JOIN complaints c ON c.id = r.complaint_id
    WHERE r.id = ? AND r.complaint_id = ? AND c.author_id = ? AND c.hidden = 0
  `).get(responseId, complaintId, req.session.user.id);
  if (!response) return next();
  if (body.length < 10 || body.length > 5000) {
    setFlash(req, 'error', 'A réplica deve ter entre 10 e 5.000 caracteres.');
    return res.redirect(`/reclamacoes/${complaintId}#respostas`);
  }
  try {
    db.prepare('INSERT INTO replies (response_id, author_id, body) VALUES (?, ?, ?)')
      .run(responseId, req.session.user.id, body);
    setFlash(req, 'success', 'Sua réplica foi publicada.');
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) {
      setFlash(req, 'error', 'Você já publicou uma réplica para esta resposta.');
    } else {
      throw error;
    }
  }
  res.redirect(`/reclamacoes/${complaintId}#respostas`);
});

app.post('/reclamacoes/:id/resolver', requireAuth, requireRole('WORKER'), (req, res, next) => {
  const result = db.prepare(`
    UPDATE complaints SET status = 'RESOLVED'
    WHERE id = ? AND author_id = ? AND hidden = 0
  `).run(Number(req.params.id), req.session.user.id);
  if (!result.changes) return next();
  setFlash(req, 'success', 'Que bom! A reclamação foi marcada como resolvida.');
  res.redirect(`/reclamacoes/${req.params.id}`);
});

app.post('/reclamacoes/:id/apoiar', requireAuth, requireRole('WORKER'), asyncRoute(async (req, res, next) => {
  const complaintId = Number(req.params.id);
  const kind = req.body.kind === 'AFFECTED' ? 'AFFECTED' : 'SUPPORT';
  const story = String(req.body.story || '').trim();
  if (story.length > 2000) {
    setFlash(req, 'error', 'Seu relato complementar deve ter até 2.000 caracteres.');
    return res.redirect(`/reclamacoes/${complaintId}#apoio`);
  }
  const complaint = db.prepare('SELECT id, author_id FROM complaints WHERE id = ? AND hidden = 0')
    .get(complaintId);
  if (!complaint) return next();
  if (complaint.author_id === req.session.user.id) {
    setFlash(req, 'error', 'O autor já representa apoio à própria causa.');
    return res.redirect(`/reclamacoes/${complaintId}#apoio`);
  }
  db.prepare(`
    INSERT INTO supports (complaint_id, user_id, kind, story)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(complaint_id, user_id)
    DO UPDATE SET kind = excluded.kind, story = excluded.story
  `).run(complaintId, req.session.user.id, kind, story);
  await notifyThreshold(complaintId);
  setFlash(req, 'success', kind === 'AFFECTED'
    ? 'Seu relato foi somado às pessoas afetadas.'
    : 'Seu apoio foi registrado.');
  res.redirect(`/reclamacoes/${complaintId}#apoio`);
}));

app.post('/reclamacoes/:id/denunciar', requireAuth, (req, res, next) => {
  const complaintId = Number(req.params.id);
  const reason = String(req.body.reason || '').trim();
  if (!db.prepare('SELECT 1 FROM complaints WHERE id = ?').get(complaintId)) return next();
  if (reason.length < 10 || reason.length > 1000) {
    setFlash(req, 'error', 'Explique o motivo da denúncia usando entre 10 e 1.000 caracteres.');
    return res.redirect(`/reclamacoes/${complaintId}#denunciar`);
  }
  try {
    db.prepare(`
      INSERT INTO reports (complaint_id, reporter_id, reason) VALUES (?, ?, ?)
    `).run(complaintId, req.session.user.id, reason);
    setFlash(req, 'success', 'Denúncia recebida. A moderação fará a análise.');
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) {
      setFlash(req, 'info', 'Você já denunciou este conteúdo. A análise está registrada.');
    } else {
      throw error;
    }
  }
  res.redirect(`/reclamacoes/${complaintId}`);
});

app.get('/direitos', (req, res) => {
  const categoryId = Number(req.query.categoria) || null;
  const articles = db.prepare(`
    SELECT a.*, cat.name AS category_name, cat.icon AS category_icon
    FROM rights_articles a JOIN categories cat ON cat.id = a.category_id
    ${categoryId ? 'WHERE a.category_id = ?' : ''}
    ORDER BY cat.name, a.title
  `).all(...(categoryId ? [categoryId] : []));
  res.render('rights', { articles, selectedCategory: categoryId, ...referenceData() });
});

app.get('/cadastro', (req, res) => {
  res.render('register', { errors: [], values: {}, ...referenceData() });
});

app.post('/cadastro', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const accountType = req.body.account_type === 'COMPANY' ? 'COMPANY' : 'WORKER';
  const companyName = String(req.body.company_name || '').trim();
  const municipalityId = Number(req.body.municipality_id);
  const contactEmail = String(req.body.contact_email || '').trim().toLowerCase();
  const whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '');
  const errors = [];
  if (name.length < 3 || name.length > 100) errors.push('Informe seu nome com 3 a 100 caracteres.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Informe um e-mail válido.');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    errors.push('A senha deve ter ao menos 8 caracteres, uma letra e um número.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) errors.push('Já existe uma conta com este e-mail.');
  if (accountType === 'COMPANY') {
    if (companyName.length < 3 || companyName.length > 150) errors.push('Informe o nome da empresa ou órgão.');
    if (!db.prepare('SELECT 1 FROM municipalities WHERE id = ?').get(municipalityId)) errors.push('Selecione o município da entidade.');
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) errors.push('Informe um e-mail público válido.');
    if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 15)) errors.push('Informe o WhatsApp com DDD e código do país.');
    if (!contactEmail && !whatsapp) errors.push('Informe ao menos um contato público da entidade.');
  }
  const values = { name, email, account_type: accountType, company_name: companyName, municipality_id: municipalityId, contact_email: contactEmail, whatsapp };
  if (errors.length) return res.status(422).render('register', { errors, values, ...referenceData() });

  try {
    const userId = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)
      `).run(name, email, bcrypt.hashSync(password, 12), accountType);
      const id = Number(result.lastInsertRowid);
      if (accountType === 'COMPANY') {
        const companyResult = db.prepare(`
          INSERT INTO companies
            (name, slug, municipality_id, email, whatsapp, description)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          companyName, uniqueCompanySlug(companyName), municipalityId,
          contactEmail || null, whatsapp || null,
          'Entidade cadastrada por seu representante na plataforma.'
        );
        db.prepare('INSERT INTO company_members (user_id, company_id) VALUES (?, ?)')
          .run(id, Number(companyResult.lastInsertRowid));
      }
      return id;
    })();
    req.session.user = { id: userId, name, email, role: accountType };
    setFlash(req, 'success', 'Cadastro realizado. Boas-vindas ao Teu Direito!');
    res.redirect('/minha-area');
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) {
      errors.push('Não foi possível cadastrar: e-mail ou entidade já existente neste município.');
      return res.status(422).render('register', { errors, values, ...referenceData() });
    }
    throw error;
  }
});

app.get('/entrar', (req, res) => {
  res.render('login', { next: safeNext(req.query.next || '/minha-area') });
});

app.post('/entrar', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    setFlash(req, 'error', 'E-mail ou senha incorretos.');
    return res.redirect('/entrar');
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).render('message', {
      title: 'Não foi possível entrar',
      message: 'Tente novamente em instantes.'
    });
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    res.redirect(safeNext(req.body.next));
  });
});

app.post('/sair', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('teu-direito.sid');
    res.redirect('/');
  });
});

app.get('/minha-area', requireAuth, (req, res) => {
  let complaints = [];
  let companyData = [];
  if (req.session.user.role === 'WORKER') {
    complaints = db.prepare(`
      SELECT c.*, cat.name AS category_name, m.name AS municipality_name,
        COUNT(DISTINCT s.id) AS support_count
      FROM complaints c
      JOIN categories cat ON cat.id = c.category_id
      JOIN municipalities m ON m.id = c.municipality_id
      LEFT JOIN supports s ON s.complaint_id = c.id
      WHERE c.author_id = ?
      GROUP BY c.id ORDER BY c.created_at DESC
    `).all(req.session.user.id);
  } else if (req.session.user.role === 'COMPANY') {
    companyData = db.prepare(`
      SELECT company.*, m.name AS municipality_name,
        COUNT(DISTINCT c.id) AS complaint_count
      FROM company_members cm
      JOIN companies company ON company.id = cm.company_id
      JOIN municipalities m ON m.id = company.municipality_id
      LEFT JOIN complaint_companies cc ON cc.company_id = company.id
      LEFT JOIN complaints c ON c.id = cc.complaint_id AND c.hidden = 0
      WHERE cm.user_id = ?
      GROUP BY company.id
    `).all(req.session.user.id);
    const companyIds = companyData.map((company) => company.id);
    if (companyIds.length) {
      complaints = listComplaints({ companyId: companyIds[0], limit: 100 });
    }
  }
  res.render('dashboard', { complaints, companyData });
});

app.get('/moderacao', requireAuth, requireRole('MODERATOR'), (req, res) => {
  const reports = db.prepare(`
    SELECT report.*, c.title, c.hidden, reporter.name AS reporter_name,
      reviewer.name AS reviewer_name
    FROM reports report
    JOIN complaints c ON c.id = report.complaint_id
    JOIN users reporter ON reporter.id = report.reporter_id
    LEFT JOIN users reviewer ON reviewer.id = report.reviewed_by
    ORDER BY CASE report.status WHEN 'OPEN' THEN 0 ELSE 1 END, report.created_at DESC
  `).all();
  const notifications = db.prepare(`
    SELECT n.*, c.title, company.name AS company_name
    FROM notifications n
    JOIN complaints c ON c.id = n.complaint_id
    JOIN companies company ON company.id = n.company_id
    ORDER BY n.created_at DESC LIMIT 50
  `).all();
  res.render('moderation', { reports, notifications });
});

app.post('/moderacao/denuncias/:id', requireAuth, requireRole('MODERATOR'), (req, res, next) => {
  const reportId = Number(req.params.id);
  const action = req.body.action === 'hide' ? 'CONTENT_HIDDEN' : 'DISMISSED';
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (!report) return next();
  db.transaction(() => {
    if (action === 'CONTENT_HIDDEN') {
      db.prepare('UPDATE complaints SET hidden = 1 WHERE id = ?').run(report.complaint_id);
    }
    db.prepare(`
      UPDATE reports
      SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(action, req.session.user.id, reportId);
  })();
  setFlash(req, 'success', action === 'CONTENT_HIDDEN'
    ? 'Conteúdo ocultado e denúncia encerrada.'
    : 'Denúncia revisada e arquivada.');
  res.redirect('/moderacao');
});

app.get('/health', (req, res) => {
  db.prepare('SELECT 1 AS ok').get();
  res.json({ status: 'ok' });
});

app.use((req, res) => {
  res.status(404).render('message', {
    title: 'Página não encontrada',
    message: 'O endereço informado não existe ou o conteúdo não está mais disponível.'
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).render('message', {
    title: 'Algo deu errado',
    message: 'Não foi possível concluir a operação. Tente novamente em instantes.'
  });
});

app.listen(port, () => {
  console.log(`Teu Direito disponível em http://localhost:${port}`);
});

module.exports = app;