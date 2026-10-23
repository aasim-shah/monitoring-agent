export type DeliveryEvent = 'opened' | 'resolved' | 'escalated' | 'test';

export interface IncidentForMessage {
  id: string;
  productId: string | null;
  title: string;
  severity: 'critical' | 'warning' | 'info';
  status: 'open' | 'acknowledged' | 'resolved';
  summary: string;
  startedAt: Date;
}

export interface Message {
  subject: string;
  text: string;
  html: string;
  slack: { text: string };
  json: Record<string, unknown>;
}

const PHRASE: Record<Exclude<DeliveryEvent, 'test'>, string> = {
  opened: 'opened',
  resolved: 'resolved',
  escalated: 'still unacknowledged after 15 min',
};

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One message in every channel's shape; the wording comes from the deterministic summary. */
export function render(event: DeliveryEvent, incident: IncidentForMessage | null, link: string): Message {
  if (event === 'test' || !incident) {
    const text = `This is a test notification from Product Control Plane. Notifications for this channel work.\n${link}`;
    return {
      subject: 'Product Control Plane test notification',
      text,
      html: `<p>This is a test notification from Product Control Plane. Notifications for this channel work.</p><p><a href="${escape(link)}">Open Product Control Plane</a></p>`,
      slack: { text: `Test notification from Product Control Plane: this channel works. <${link}|Open>` },
      json: { type: 'test', link },
    };
  }
  const head = `[${incident.severity.toUpperCase()}] ${incident.title}`;
  const subject = `${head} — ${PHRASE[event]}`;
  const started = incident.startedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const text = `${subject}\n\n${incident.summary}\n\nStarted ${started}. Status: ${incident.status}.\n\n${link}`;
  return {
    subject,
    text,
    html:
      `<p><strong>${escape(subject)}</strong></p><p>${escape(incident.summary)}</p>` +
      `<p>Started ${escape(started)}. Status: ${escape(incident.status)}.</p>` +
      `<p><a href="${escape(link)}">Open the incident</a></p>`,
    slack: { text: `*${head}* — ${PHRASE[event]}\n${incident.summary}\n<${link}|Open the incident>` },
    json: {
      type: `incident.${event}`,
      incident: {
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        summary: incident.summary,
        startedAt: incident.startedAt.toISOString(),
      },
      link,
    },
  };
}
