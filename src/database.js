const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const databasePath = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH || 'data/teu-direito.db'
);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE municipalities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK(length(state) = 2),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name, state)
      );

      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        icon TEXT NOT NULL DEFAULT '📌',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        municipality_id INTEGER NOT NULL REFERENCES municipalities(id),
        email TEXT,
        whatsapp TEXT,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name, municipality_id)
      );

      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('WORKER', 'COMPANY', 'MODERATOR')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE company_members (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, company_id)
      );

      CREATE TABLE complaints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author_id INTEGER NOT NULL REFERENCES users(id),
        municipality_id INTEGER NOT NULL REFERENCES municipalities(id),
        category_id INTEGER NOT NULL REFERENCES categories(id),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 8 AND 140),
        description TEXT NOT NULL CHECK(length(description) BETWEEN 30 AND 5000),
        status TEXT NOT NULL DEFAULT 'WAITING_REPLY'
          CHECK(status IN ('WAITING_REPLY', 'ANSWERED', 'RESOLVED')),
        hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE complaint_companies (
        complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(complaint_id, company_id)
      );

      CREATE TABLE responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        author_id INTEGER NOT NULL REFERENCES users(id),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 20 AND 5000),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(complaint_id, company_id)
      );

      CREATE TABLE replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id INTEGER NOT NULL UNIQUE REFERENCES responses(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 10 AND 5000),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE supports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('SUPPORT', 'AFFECTED')),
        story TEXT NOT NULL DEFAULT '' CHECK(length(story) <= 2000),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(complaint_id, user_id)
      );

      CREATE TABLE reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        reporter_id INTEGER NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'DISMISSED', 'CONTENT_HIDDEN')),
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(complaint_id, reporter_id)
      );

      CREATE TABLE rights_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        responsible_agencies TEXT NOT NULL,
        next_steps TEXT NOT NULL,
        source_url TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        channel TEXT NOT NULL CHECK(channel IN ('EMAIL', 'WHATSAPP')),
        destination TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SENT', 'FAILED')),
        error TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(complaint_id, company_id, channel)
      );

      CREATE INDEX idx_companies_name ON companies(name);
      CREATE INDEX idx_companies_municipality ON companies(municipality_id);
      CREATE INDEX idx_complaints_filters ON complaints(municipality_id, category_id, status);
      CREATE INDEX idx_complaints_created ON complaints(created_at DESC);
      CREATE INDEX idx_reports_status ON reports(status);
      CREATE INDEX idx_sessions_expiration ON sessions(expires_at);

      CREATE TRIGGER municipalities_updated AFTER UPDATE ON municipalities
      BEGIN UPDATE municipalities SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER categories_updated AFTER UPDATE ON categories
      BEGIN UPDATE categories SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER companies_updated AFTER UPDATE ON companies
      BEGIN UPDATE companies SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER users_updated AFTER UPDATE ON users
      BEGIN UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER sessions_updated AFTER UPDATE ON sessions
      BEGIN UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE sid = NEW.sid; END;
      CREATE TRIGGER complaints_updated AFTER UPDATE ON complaints
      BEGIN UPDATE complaints SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER responses_updated AFTER UPDATE ON responses
      BEGIN UPDATE responses SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER replies_updated AFTER UPDATE ON replies
      BEGIN UPDATE replies SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER supports_updated AFTER UPDATE ON supports
      BEGIN UPDATE supports SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER reports_updated AFTER UPDATE ON reports
      BEGIN UPDATE reports SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER rights_articles_updated AFTER UPDATE ON rights_articles
      BEGIN UPDATE rights_articles SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
      CREATE TRIGGER notifications_updated AFTER UPDATE ON notifications
      BEGIN UPDATE notifications SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
    `
  }
];

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = db.prepare('SELECT version FROM schema_migrations').all()
    .map((row) => row.version);

  for (const migration of migrations) {
    if (applied.includes(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    })();
  }
}

function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function seed() {
  const hasData = db.prepare('SELECT COUNT(*) AS total FROM municipalities').get().total > 0;
  if (hasData) return;

  db.transaction(() => {
    const municipalityInsert = db.prepare(
      'INSERT INTO municipalities (name, state) VALUES (?, ?)'
    );
    const municipalities = [
      ['São Paulo', 'SP'], ['Guarulhos', 'SP'], ['Campinas', 'SP'],
      ['Rio de Janeiro', 'RJ'], ['Belo Horizonte', 'MG'], ['Salvador', 'BA'],
      ['Recife', 'PE'], ['Porto Alegre', 'RS'], ['Fortaleza', 'CE']
    ];
    const municipalityIds = {};
    for (const [name, state] of municipalities) {
      municipalityIds[name] = Number(municipalityInsert.run(name, state).lastInsertRowid);
    }

    const categoryInsert = db.prepare(
      'INSERT INTO categories (name, slug, icon) VALUES (?, ?, ?)'
    );
    const categories = [
      ['Salário e pagamentos', 'salario-e-pagamentos', '💰'],
      ['Jornada de trabalho', 'jornada-de-trabalho', '⏱️'],
      ['Benefícios', 'beneficios', '🧾'],
      ['Condições de trabalho', 'condicoes-de-trabalho', '🦺'],
      ['Transporte', 'transporte', '🚌'],
      ['Serviços públicos', 'servicos-publicos', '🏛️'],
      ['Meio ambiente e comunidade', 'meio-ambiente-comunidade', '🌱'],
      ['Outros', 'outros', '📌']
    ];
    const categoryIds = {};
    for (const [name, slug, icon] of categories) {
      categoryIds[slug] = Number(categoryInsert.run(name, slug, icon).lastInsertRowid);
    }

    const companyInsert = db.prepare(`
      INSERT INTO companies (name, slug, municipality_id, email, whatsapp, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const busId = Number(companyInsert.run(
      'Viação Horizonte', 'viacao-horizonte', municipalityIds['São Paulo'],
      'atendimento@horizonte.example', '5511999990001',
      'Operadora de transporte coletivo urbano.'
    ).lastInsertRowid);
    const marketId = Number(companyInsert.run(
      'Mercado Bom Vizinho', 'mercado-bom-vizinho', municipalityIds['Guarulhos'],
      'pessoas@bomvizinho.example', '5511999990002',
      'Rede varejista com unidades na Grande São Paulo.'
    ).lastInsertRowid);
    const cityId = Number(companyInsert.run(
      'Prefeitura de São Paulo', 'prefeitura-de-sao-paulo', municipalityIds['São Paulo'],
      'ouvidoria@prefeitura.example', '5511999990003',
      'Órgão público municipal cadastrado para receber manifestações.'
    ).lastInsertRowid);

    const passwordHash = bcrypt.hashSync('Demo@123', 12);
    const userInsert = db.prepare(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
    );
    const workerId = Number(userInsert.run(
      'Marina Santos', 'trabalhador@demo.local', passwordHash, 'WORKER'
    ).lastInsertRowid);
    const companyUserId = Number(userInsert.run(
      'Equipe Viação Horizonte', 'empresa@demo.local', passwordHash, 'COMPANY'
    ).lastInsertRowid);
    userInsert.run('Moderação Teu Direito', 'moderacao@demo.local', passwordHash, 'MODERATOR');
    db.prepare('INSERT INTO company_members (user_id, company_id) VALUES (?, ?)')
      .run(companyUserId, busId);

    const complaintInsert = db.prepare(`
      INSERT INTO complaints
        (author_id, municipality_id, category_id, title, description, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const complaintOne = Number(complaintInsert.run(
      workerId,
      municipalityIds['São Paulo'],
      categoryIds['transporte'],
      'Atrasos frequentes na linha do bairro',
      'Há mais de três semanas os ônibus da linha do bairro chegam com atrasos superiores a quarenta minutos, prejudicando trabalhadores no início do expediente.',
      'ANSWERED'
    ).lastInsertRowid);
    const complaintTwo = Number(complaintInsert.run(
      workerId,
      municipalityIds['Guarulhos'],
      categoryIds['beneficios'],
      'Vale-alimentação não foi creditado',
      'O benefício previsto para o início do mês ainda não foi creditado e não recebemos uma previsão clara para regularização do pagamento.',
      'WAITING_REPLY'
    ).lastInsertRowid);
    db.prepare('INSERT INTO complaint_companies (complaint_id, company_id) VALUES (?, ?)')
      .run(complaintOne, busId);
    db.prepare('INSERT INTO complaint_companies (complaint_id, company_id) VALUES (?, ?)')
      .run(complaintTwo, marketId);

    db.prepare(`
      INSERT INTO responses (complaint_id, company_id, author_id, body)
      VALUES (?, ?, ?, ?)
    `).run(
      complaintOne, busId, companyUserId,
      'Identificamos uma indisponibilidade temporária de veículos e reorganizamos a escala. A operação será monitorada durante os próximos dias.'
    );

    const rightsInsert = db.prepare(`
      INSERT INTO rights_articles
        (category_id, title, summary, content, responsible_agencies, next_steps, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    rightsInsert.run(
      categoryIds['salario-e-pagamentos'],
      'Pagamento de salário e verbas trabalhistas',
      'Entenda prazos gerais e onde buscar informação quando um pagamento atrasa.',
      'Em regra, o salário mensal deve ser pago até o quinto dia útil do mês seguinte ao trabalhado. Guarde comprovantes, holerites e comunicações. Situações específicas podem depender do contrato e da convenção coletiva.',
      'Sindicato da categoria; Superintendência Regional do Trabalho; Ministério Público do Trabalho.',
      'Registre datas e valores, solicite esclarecimento por escrito e consulte seu sindicato ou um profissional habilitado para avaliar o caso concreto.',
      'https://www.gov.br/trabalho-e-emprego/'
    );
    rightsInsert.run(
      categoryIds['jornada-de-trabalho'],
      'Jornada, intervalos e registro de ponto',
      'Informações iniciais sobre jornada e preservação de registros.',
      'A legislação estabelece limites e intervalos, mas há regras específicas conforme atividade, escala e negociação coletiva. Preserve espelhos de ponto, escalas e mensagens relacionadas aos horários.',
      'Sindicato da categoria; Inspeção do Trabalho; Ministério Público do Trabalho.',
      'Compare os registros com sua rotina, peça correções formalmente e procure orientação especializada se houver divergências.',
      'https://www.gov.br/trabalho-e-emprego/'
    );
    rightsInsert.run(
      categoryIds['beneficios'],
      'Benefícios previstos em contrato ou norma coletiva',
      'Saiba como organizar informações sobre benefício não fornecido.',
      'Vale-transporte, alimentação e outros benefícios podem decorrer da lei, contrato ou convenção coletiva. Identifique a origem do benefício antes de avaliar quais regras se aplicam.',
      'Setor responsável da entidade; sindicato da categoria; Inspeção do Trabalho.',
      'Reúna contrato, holerites e norma coletiva, protocole o pedido de esclarecimento e guarde a resposta.',
      'https://www.gov.br/trabalho-e-emprego/'
    );
    rightsInsert.run(
      categoryIds['condicoes-de-trabalho'],
      'Ambiente de trabalho seguro',
      'Orientações gerais para registrar riscos e buscar canais responsáveis.',
      'Empregadores devem adotar medidas de saúde e segurança. Não se exponha a perigo para produzir provas. Registre condições com segurança e procure os responsáveis internos.',
      'CIPA ou responsável por segurança; sindicato; Inspeção do Trabalho; Ministério Público do Trabalho.',
      'Comunique o risco pelos canais internos e, diante de risco grave ou persistente, busque um órgão competente.',
      'https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho'
    );
    rightsInsert.run(
      categoryIds['transporte'],
      'Problemas no transporte coletivo',
      'Como registrar falhas recorrentes de linhas e serviços.',
      'Horários, itinerários e canais de reclamação variam por município. Anote linha, prefixo do veículo, local, data e horário para tornar o relato verificável.',
      'Operadora; órgão municipal ou metropolitano de transporte; ouvidoria pública; Procon.',
      'Registre protocolo na operadora e no órgão gestor. Em urgências de segurança, procure os serviços públicos adequados.',
      'https://www.gov.br/mdr/pt-br/assuntos/mobilidade-e-servicos-urbanos'
    );
    rightsInsert.run(
      categoryIds['servicos-publicos'],
      'Ouvidorias e acesso a serviços públicos',
      'Canais para solicitar providências e acompanhar protocolos.',
      'O cidadão pode usar ouvidorias e serviços de informação para registrar solicitações. O canal responsável depende do ente e do serviço envolvido.',
      'Ouvidoria do órgão; prefeitura; governo estadual; Fala.BR para órgãos federais.',
      'Faça um protocolo com descrição objetiva, local e datas; guarde o número e acompanhe o prazo informado.',
      'https://falabr.cgu.gov.br/'
    );

    // Mantém o seed coerente com todas as chaves estrangeiras e também mostra
    // que uma manifestação pode envolver mais de uma entidade.
    db.prepare('INSERT INTO complaint_companies (complaint_id, company_id) VALUES (?, ?)')
      .run(complaintOne, cityId);
  })();
}

migrate();
seed();

module.exports = { db, slugify, databasePath };