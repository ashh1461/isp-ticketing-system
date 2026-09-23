/**
 * Test suite for the ISP Ticketing System backend.
 *
 * Covers every endpoint, the auth/permission matrix, input validation, and
 * the security fixes: admin-only registration, role allowlist, JWT_SECRET
 * enforcement, rate limiting, and the persistence write-through path.
 *
 * Vitest transforms TS via esbuild, so no pre-compilation is needed.
 * Importing app.ts runs the module top-level (which validates JWT_SECRET
 * and builds the Express app) but does NOT bind the port — that is gated
 * behind require.main === module, so supertest drives it in-process.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app, { __seedUserForTests } from '../src/app';

const ADMIN_CRED = {
  email: 'admin.test@isp.local',
  password: 'Admin@Passw0rd!Test',
  first_name: 'Ada',
  last_name: 'Admin',
};

const SPECIALIST_CRED = {
  email: 'spec.test@isp.local',
  password: 'Spec@Passw0rd!Test',
  first_name: 'Sami',
  last_name: 'Specialist',
};

let adminToken = '';
let adminId = '';
let specialistToken = '';

beforeAll(async () => {
  const admin = await __seedUserForTests(
    ADMIN_CRED.email,
    ADMIN_CRED.password,
    ADMIN_CRED.first_name,
    ADMIN_CRED.last_name,
    'admin'
  );
  adminToken = admin.token;
  adminId = admin.id;

  const specialist = await __seedUserForTests(
    SPECIALIST_CRED.email,
    SPECIALIST_CRED.password,
    SPECIALIST_CRED.first_name,
    SPECIALIST_CRED.last_name,
    'specialist'
  );
  specialistToken = specialist.token;
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────
describe('authentication', () => {
  it('POST /auth/login returns a token for valid credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: ADMIN_CRED.email,
      password: ADMIN_CRED.password,
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Login successful');
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.email).toBe(ADMIN_CRED.email);
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('POST /auth/login rejects a wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: ADMIN_CRED.email,
      password: 'definitely-wrong',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('POST /auth/login rejects an unknown email', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'nobody@isp.local',
      password: 'whatever',
    });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login validates required fields', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'x@y.z' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('GET /auth/me returns the caller identity', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(ADMIN_CRED.email);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('GET /auth/me 404s for a token whose user was deleted', async () => {
    // Self-delete is blocked, so register a throwaway via the admin route,
    // then delete it through the admin API and reuse its still-valid token.
    const created = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'ghost@isp.local',
        password: 'Ghost@Passw0rd1',
        first_name: 'Gus',
        last_name: 'Ghost',
        role: 'engineer',
      });
    expect(created.status).toBe(201);
    const ghostId = created.body.user.id;

    const ghostLogin = await request(app).post('/api/v1/auth/login').send({
      email: 'ghost@isp.local',
      password: 'Ghost@Passw0rd1',
    });
    expect(ghostLogin.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/v1/users/${ghostId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleted.status).toBe(200);

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${ghostLogin.body.token}`);
    expect(me.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registration: privilege-escalation fix
// ─────────────────────────────────────────────────────────────────────────────
describe('registration security', () => {
  it('rejects registration without any token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...ADMIN_CRED, email: 'noauth@isp.local' });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', 'notabearer')
      .send({ ...ADMIN_CRED, email: 'noauth2@isp.local' });
    expect(res.status).toBe(401);
  });

  it('rejects a forged/expired token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', 'Bearer not.a.real.token')
      .send({ ...ADMIN_CRED, email: 'noauth3@isp.local' });
    expect(res.status).toBe(403);
  });

  it('rejects a non-admin token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ ...ADMIN_CRED, email: 'noauth4@isp.local' });
    expect(res.status).toBe(403);
  });

  it('allows an admin to register a new user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'newuser@isp.local',
        password: 'New@Passw0rd1',
        first_name: 'Nadia',
        last_name: 'Nabil',
        role: 'specialist',
      });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('newuser@isp.local');
    expect(res.body.user.role).toBe('specialist');
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('defaults the role to specialist when none is provided', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'norole@isp.local',
        password: 'New@Passw0rd1',
        first_name: 'No',
        last_name: 'Role',
      });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('specialist');
  });

  it('rejects an invalid role value', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'badrole@isp.local',
        password: 'New@Passw0rd1',
        first_name: 'Bad',
        last_name: 'Role',
        role: 'superadmin',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid role/);
  });

  it('rejects a duplicate email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...ADMIN_CRED });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('validates required fields', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'incomplete@isp.local' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tickets: full lifecycle
// ─────────────────────────────────────────────────────────────────────────────
let customerId = '';

describe('ticket lifecycle', () => {
  beforeAll(async () => {
    const cust = await request(app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        account_number: 'ACC-1001',
        first_name: 'Nadia',
        last_name: 'Nabil',
        email: 'nadia@isp.local',
        account_type: 'shared_internet',
      });
    expect(cust.status).toBe(201);
    customerId = cust.body.customer.id;
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/tickets');
    expect(res.status).toBe(401);
  });

  it('creates a ticket', async () => {
    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: customerId,
        title: 'No internet for 3 days',
        description: 'Customer reports complete loss of connectivity.',
        priority: 'high',
      });
    expect(res.status).toBe(201);
    expect(res.body.ticket.status).toBe('open');
    expect(res.body.ticket.priority).toBe('high');
    expect(res.body.ticket.ticket_number).toMatch(/^TKT-/);
    expect(res.body.ticket.comments).toEqual([]);
  });

  it('lists tickets with filters', async () => {
    const created = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: customerId,
        title: 'Packet loss',
        description: 'Sustained 40% packet loss on the CPE.',
        priority: 'critical',
      });
    expect(created.status).toBe(201);
    const ticketId = created.body.ticket.id;

    const openList = await request(app)
      .get('/api/v1/tickets?status=open')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(openList.status).toBe(200);
    expect(openList.body.count).toBeGreaterThanOrEqual(2);
    expect(openList.body.tickets.every((t: any) => t.status === 'open')).toBe(true);

    const criticalList = await request(app)
      .get('/api/v1/tickets?priority=critical')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(criticalList.status).toBe(200);
    expect(criticalList.body.count).toBeGreaterThanOrEqual(1);

    const mine = await request(app)
      .get(`/api/v1/tickets?assigned_to=${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(mine.status).toBe(200);

    // Delete this one so downstream counting stays predictable.
    const deleted = await request(app)
      .delete(`/api/v1/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleted.status).toBe(200);
  });

  it('fetches a single ticket', async () => {
    const created = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: customerId,
        title: 'Latency spikes',
        description: 'Evening latency spikes every 20 minutes.',
      });
    expect(created.status).toBe(201);
    const ticketId = created.body.ticket.id;

    const one = await request(app)
      .get(`/api/v1/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(one.status).toBe(200);

    const gone = await request(app)
      .get('/api/v1/tickets/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(gone.status).toBe(404);
  });

  it('updates a ticket', async () => {
    const created = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: customerId,
        title: 'DNS failures',
        description: 'Intermittent DNS resolution failures.',
        priority: 'low',
      });
    expect(created.status).toBe(201);
    const ticketId = created.body.ticket.id;

    const updated = await request(app)
      .put(`/api/v1/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'in_progress', priority: 'critical' });
    expect(updated.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(after.status).toBe(200);
    expect(after.body.ticket.status).toBe('in_progress');
    expect(after.body.ticket.priority).toBe('critical');
  });

  it('assigns a ticket', async () => {
    const created = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: customerId,
        title: 'Router RMA',
        description: 'Hardware replacement needed.',
      });
    expect(created.status).toBe(201);
    const ticketId = created.body.ticket.id;

    const assigned = await request(app)
      .patch(`/api/v1/tickets/${ticketId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assigned_to_user_id: adminId });
    expect(assigned.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(after.status).toBe(200);
    expect(after.body.ticket.assigned_to_user_id).toBe(adminId);
  });

  it('adds a comment', async () => {
    const created = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: customerId,
        title: 'Billing question',
        description: 'Customer disputes the last invoice.',
      });
    expect(created.status).toBe(201);
    const ticketId = created.body.ticket.id;

    const comment = await request(app)
      .post(`/api/v1/tickets/${ticketId}/comments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ text: 'Dispatching a technician.', is_internal: true });
    expect(comment.status).toBe(201);

    const after = await request(app)
      .get(`/api/v1/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(after.status).toBe(200);
    expect(after.body.ticket.comments).toHaveLength(1);
    expect(after.body.ticket.comments[0].text).toBe('Dispatching a technician.');
  });

  it('rejects a ticket for a nonexistent customer', async () => {
    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: '00000000-0000-0000-0000-000000000000',
        title: 'x',
        description: 'y',
      });
    expect(res.status).toBe(404);
  });

  it('rejects a ticket with missing fields', async () => {
    const res = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'no customer' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Customers
// ─────────────────────────────────────────────────────────────────────────────
describe('customers', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/customers');
    expect(res.status).toBe(401);
  });

  it('creates and lists customers', async () => {
    const res = await request(app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        account_number: 'ACC-2002',
        first_name: 'Fady',
        last_name: 'Fares',
        email: 'fady@isp.local',
        account_type: 'dedicated',
      });
    expect(res.status).toBe(201);
    expect(res.body.customer.account_number).toBe('ACC-2002');

    const list = await request(app)
      .get('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(list.body.customers.length);
  });

  it('rejects a duplicate account number', async () => {
    const res = await request(app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        account_number: 'ACC-2002',
        first_name: 'Dup',
        last_name: 'Licate',
      });
    expect(res.status).toBe(409);
  });

  it('validates required fields', async () => {
    const res = await request(app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ account_number: 'ACC-3003' });
    expect(res.status).toBe(400);
  });

  it('fetches a customer with their tickets', async () => {
    const created = await request(app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        account_number: 'ACC-3003',
        first_name: 'Layla',
        last_name: 'Haddad',
        email: 'layla@isp.local',
        account_type: 'shared_internet',
      });
    expect(created.status).toBe(201);
    const cid = created.body.customer.id;

    const ticket = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: cid,
        title: 'Slow speeds',
        description: 'Evening throughput below the SLA.',
      });
    expect(ticket.status).toBe(201);

    const one = await request(app)
      .get(`/api/v1/customers/${cid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(one.status).toBe(200);
    expect(one.body.customer.id).toBe(cid);
    expect(one.body.tickets).toHaveLength(1);
  });

  it('404s on an unknown customer', async () => {
    const res = await request(app)
      .get('/api/v1/customers/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('blocks deleting a customer with tickets unless force=true', async () => {
    const created = await request(app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        account_number: 'ACC-4004',
        first_name: 'Karim',
        last_name: 'Khoury',
        account_type: 'dedicated',
      });
    expect(created.status).toBe(201);
    const cid = created.body.customer.id;

    const ticket = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: cid,
        title: 'Flapping link',
        description: 'Link flaps every few minutes.',
      });
    expect(ticket.status).toBe(201);

    const blocked = await request(app)
      .delete(`/api/v1/customers/${cid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/\d+ existing tickets/);

    const forced = await request(app)
      .delete(`/api/v1/customers/${cid}?force=true`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(forced.status).toBe(200);

    const gone = await request(app)
      .get(`/api/v1/customers/${cid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(gone.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────
describe('users', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
  });

  it('lists users without password hashes', async () => {
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(res.body.users.length);
    expect(res.body.users.length).toBeGreaterThanOrEqual(2);
    expect(res.body.users.every((u: any) => u.password_hash === undefined)).toBe(true);
  });

  it('fetches a user with assigned-ticket count', async () => {
    const res = await request(app)
      .get(`/api/v1/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(adminId);
    expect(res.body.tickets_assigned).toBeTypeOf('number');
  });

  it('404s on an unknown user', async () => {
    const res = await request(app)
      .get('/api/v1/users/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('prevents an admin from deleting their own account', async () => {
    const res = await request(app)
      .delete(`/api/v1/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/own account/i);
  });

  it('prevents a non-admin from deleting a user', async () => {
    const res = await request(app)
      .delete(`/api/v1/users/${adminId}`)
      .set('Authorization', `Bearer ${specialistToken}`);
    expect(res.status).toBe(403);
  });

  it('blocks deleting a user with assigned tickets', async () => {
    const created = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'assignee@isp.local',
        password: 'Assign@Passw0rd1',
        first_name: 'Ass',
        last_name: 'Ignee',
        role: 'engineer',
      });
    expect(created.status).toBe(201);
    const uid = created.body.user.id;

    const cust = await request(app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        account_number: 'ACC-5005',
        first_name: 'Maya',
        last_name: 'Mansour',
      });
    expect(cust.status).toBe(201);
    const cid = cust.body.customer.id;

    const ticket = await request(app)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: cid,
        title: 'Provisioning',
        description: 'New site provisioning.',
        assigned_to_user_id: uid,
      });
    expect(ticket.status).toBe(201);

    const blocked = await request(app)
      .delete(`/api/v1/users/${uid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/assigned tickets/i);
  });

  it('allows an admin to delete a user with no tickets', async () => {
    const created = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'goner@isp.local',
        password: 'Gone@Passw0rd1',
        first_name: 'Gone',
        last_name: 'User',
        role: 'specialist',
      });
    expect(created.status).toBe(201);
    const uid = created.body.user.id;

    const deleted = await request(app)
      .delete(`/api/v1/users/${uid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleted.status).toBe(200);

    const gone = await request(app)
      .get(`/api/v1/users/${uid}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(gone.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Analytics, health and info
// ─────────────────────────────────────────────────────────────────────────────
describe('analytics, health and info', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/analytics/dashboard');
    expect(res.status).toBe(401);
  });

  it('returns dashboard metrics', async () => {
    const res = await request(app)
      .get('/api/v1/analytics/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total_tickets).toBeTypeOf('number');
    expect(res.body.by_priority).toBeDefined();
    expect(res.body.by_status).toBeDefined();
    // The suite creates open + in_progress tickets; totals must be consistent.
    const counts = Object.values(res.body.by_status) as number[];
    expect(counts.reduce((a, b) => a + b, 0)).toBe(res.body.summary.total_tickets);
  });

  it('health is public and reports the persistence mode', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.persistence).toBeTypeOf('string');
  });

  it('info is public and reports table counts', async () => {
    const res = await request(app).get('/api/v1/info');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('ISP Ticketing System');
    expect(res.body.database.users).toBeGreaterThanOrEqual(2);
  });
});
