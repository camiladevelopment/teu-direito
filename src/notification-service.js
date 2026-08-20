const nodemailer = require('nodemailer');
const { db } = require('./database');

function smtpTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined
  });
}

function queueThresholdNotifications(complaintId) {
  const complaint = db.prepare(`
    SELECT c.id, c.title, COUNT(s.id) AS support_count
    FROM complaints c
    LEFT JOIN supports s ON s.complaint_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(complaintId);

  if (!complaint || complaint.support_count < 50) return [];

  const companies = db.prepare(`
    SELECT company.id, company.name, company.email, company.whatsapp
    FROM complaint_companies cc
    JOIN companies company ON company.id = cc.company_id
    WHERE cc.complaint_id = ?
  `).all(complaintId);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO notifications
      (complaint_id, company_id, channel, destination)
    VALUES (?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const company of companies) {
      if (company.email) insert.run(complaintId, company.id, 'EMAIL', company.email);
      if (company.whatsapp) insert.run(complaintId, company.id, 'WHATSAPP', company.whatsapp);
    }
  })();

  return db.prepare(`
    SELECT n.*, company.name AS company_name, c.title
    FROM notifications n
    JOIN companies company ON company.id = n.company_id
    JOIN complaints c ON c.id = n.complaint_id
    WHERE n.complaint_id = ? AND n.status = 'PENDING'
  `).all(complaintId);
}

async function deliverNotification(notification) {
  const complaintUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/reclamacoes/${notification.complaint_id}`;
  const message = `A causa "${notification.title}" alcançou 50 apoios na plataforma Teu Direito. Consulte o relato público e, se representar a entidade envolvida, publique uma resposta: ${complaintUrl}`;

  try {
    if (notification.channel === 'EMAIL') {
      const transport = smtpTransport();
      if (!transport) return;
      await transport.sendMail({
        from: process.env.SMTP_FROM || 'Teu Direito <nao-responda@teudireito.local>',
        to: notification.destination,
        subject: 'Uma causa relacionada à sua entidade alcançou 50 apoios',
        text: message
      });
    } else {
      if (!process.env.WHATSAPP_WEBHOOK_URL) return;
      const response = await fetch(process.env.WHATSAPP_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env.WHATSAPP_WEBHOOK_TOKEN
            ? { authorization: `Bearer ${process.env.WHATSAPP_WEBHOOK_TOKEN}` }
            : {})
        },
        body: JSON.stringify({ to: notification.destination, message })
      });
      if (!response.ok) throw new Error(`Integração respondeu HTTP ${response.status}`);
    }

    db.prepare(`
      UPDATE notifications
      SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, error = NULL
      WHERE id = ?
    `).run(notification.id);
  } catch (error) {
    db.prepare(`
      UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ?
    `).run(String(error.message || error).slice(0, 500), notification.id);
  }
}

async function notifyThreshold(complaintId) {
  const notifications = queueThresholdNotifications(complaintId);
  await Promise.all(notifications.map(deliverNotification));
}

module.exports = { notifyThreshold, queueThresholdNotifications };