/**
 * ISP Ticketing System - Complete Backend
 * 
 * This is a fully functional backend server that you can run immediately.
 * Just add this file to your backend/src/ directory
 */

import 'dotenv/config';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import crypto from 'crypto';

import {
  initDatabase,
  flushUsers,
  flushCustomers,
  flushTickets,
  closeDatabase,
  isPersistenceEnabled,
} from './db';

// Initialize Express app
const app: Express = express();

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// NOTE: the global apiLimiter is applied further below, AFTER the limiter
// objects are constructed (express-rate-limit instances must be created before
// they are mounted, and both live in the security section that follows).

// ============================================================================
// SECURITY CONFIGURATION
// ============================================================================

// JWT_SECRET: no hardcoded fallback. If missing/empty, refuse to start.
// Declared once here; jwt.sign/verify below use this non-undefined binding.
const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET || JWT_SECRET.trim() === '') {
  throw new Error(
    'FATAL: JWT_SECRET environment variable is not set or empty. ' +
    'The server cannot start without a valid secret. ' +
    'Set JWT_SECRET in your environment or .env file.'
  );
}

// Rate limiting: strict limiter for login (per-IP, brute-force protection)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again later.' },
});

// General limiter for the rest of the API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Mount the global limiter now that both limiter objects exist. This sits
// above every route in the chain so all endpoints share the same 429 budget.
app.use(apiLimiter);

// ============================================================================
// DATABASE SIMULATION (In-Memory Store)
// ============================================================================

interface User {
  id: string;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  role: 'specialist' | 'team_lead' | 'admin' | 'engineer';
  is_active: boolean;
  created_at: string;
}

interface Ticket {
  id: string;
  ticket_number: string;
  customer_id: string;
  created_by_user_id: string;
  assigned_to_user_id: string | null;
  status: 'open' | 'in_progress' | 'on_hold' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  comments: Comment[];
  created_at: string;
  updated_at: string;
}

interface Comment {
  id: string;
  ticket_id: string;
  user_id: string;
  text: string;
  is_internal: boolean;
  created_at: string;
}

interface Customer {
  id: string;
  account_number: string;
  first_name: string;
  last_name: string;
  email: string;
  account_type: 'shared_internet' | 'dedicated';
  created_at: string;
}

// In-memory store, hydrated from PostgreSQL on boot and written through on
// every mutation. See db.ts.
const database = {
  users: [] as User[],
  tickets: [] as Ticket[],
  customers: [] as Customer[],
};

// ============================================================================
// UTILITIES
// ============================================================================

// Generate ticket number
function generateTicketNumber(): string {
  const date = new Date().toISOString().slice(0, 8).replace(/-/g, '');
  const random = Math.floor(Math.random() * 1000).toString().padStart(6, '0');
  return `TKT-${date}-${random}`;
}

// Hash password
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

// Compare password
async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Create JWT token
function createToken(userId: string, role: string): string {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '24h' });
}

// Verify JWT token
function verifyToken(token: string): any {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// ============================================================================
// MIDDLEWARE: AUTHENTICATION
// ============================================================================

interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    // Invalid/expired token is an AUTHENTICATION failure, not authorization.
    // Must be 401 so clients can reliably detect "session dead" and log out.
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.userId = decoded.userId;
  req.userRole = decoded.role;
  next();
};

// Role-based authorization middleware
const requireRole = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      const required = roles[0].charAt(0).toUpperCase() + roles[0].slice(1);
      return res.status(403).json({ error: `${required} access required` });
    }
    next();
  };
};

// ============================================================================
// ROUTES: AUTHENTICATION
// ============================================================================

/**
 * POST /api/v1/auth/register
 * Register new user (admin only — prevents privilege escalation)
 * The role field is validated, never trusted from the client.
 */
app.post('/api/v1/auth/register', authenticateToken, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { email, password, first_name, last_name, role } = req.body;

    // Validation
    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Allowed roles — any other value is rejected, never defaulted-to-admin
    const ALLOWED_ROLES = ['admin', 'team_lead', 'specialist', 'engineer'];
    const requestedRole = role || 'specialist';
    if (!ALLOWED_ROLES.includes(requestedRole)) {
      return res.status(400).json({ error: `Invalid role. Allowed roles: ${ALLOWED_ROLES.join(', ')}` });
    }

    // Check if user exists
    if (database.users.find(u => u.email === email)) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Create user
    const userId = uuidv4();
    const passwordHash = await hashPassword(password);
    
    const newUser: User = {
      id: userId,
      email,
      password_hash: passwordHash,
      first_name,
      last_name,
      role: requestedRole,
      is_active: true,
      created_at: new Date().toISOString(),
    };

    database.users.push(newUser);

    await flushUsers(database);

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: newUser.id,
        email: newUser.email,
        first_name: newUser.first_name,
        last_name: newUser.last_name,
        role: newUser.role,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed', details: (error as Error).message });
  }
});

/**
 * GET /api/v1/auth/me
 * Return the currently authenticated user's identity
 */
app.get('/api/v1/auth/me', authenticateToken, (req: AuthRequest, res: Response) => {
  const user = database.users.find(u => u.id === req.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
    },
  });
});

/**
 * POST /api/v1/auth/login
 * Login user
 */
app.post('/api/v1/auth/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = database.users.find(u => u.email === email);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createToken(user.id, user.role);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed', details: (error as Error).message });
  }
});

// ============================================================================
// ROUTES: TICKETS
// ============================================================================

/**
 * POST /api/v1/tickets
 * Create a new ticket
 */
app.post('/api/v1/tickets', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { customer_id, title, description, priority, assigned_to_user_id } = req.body;

    if (!customer_id || !title || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify customer exists
    const customer = database.customers.find(c => c.id === customer_id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const ticketId = uuidv4();
    const newTicket: Ticket = {
      id: ticketId,
      ticket_number: generateTicketNumber(),
      customer_id,
      created_by_user_id: req.userId!,
      assigned_to_user_id: assigned_to_user_id || null,
      status: 'open',
      priority: priority || 'medium',
      title,
      description,
      comments: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    database.tickets.push(newTicket);

    await flushTickets(database);

    res.status(201).json({
      message: 'Ticket created successfully',
      ticket: newTicket,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create ticket', details: (error as Error).message });
  }
});

/**
 * GET /api/v1/tickets
 * Get all tickets with optional filters
 */
app.get('/api/v1/tickets', authenticateToken, (req: AuthRequest, res: Response) => {
  try {
    const { status, priority, assigned_to } = req.query;

    let filtered = database.tickets;

    if (status) {
      filtered = filtered.filter(t => t.status === status);
    }

    if (priority) {
      filtered = filtered.filter(t => t.priority === priority);
    }

    if (assigned_to) {
      filtered = filtered.filter(t => t.assigned_to_user_id === assigned_to);
    }

    res.json({
      count: filtered.length,
      tickets: filtered,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tickets', details: (error as Error).message });
  }
});

/**
 * GET /api/v1/tickets/:id
 * Get ticket details
 */
app.get('/api/v1/tickets/:id', authenticateToken, (req: AuthRequest, res: Response) => {
  try {
    const ticket = database.tickets.find(t => t.id === req.params.id);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Get customer details
    const customer = database.customers.find(c => c.id === ticket.customer_id);

    res.json({
      ticket,
      customer,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticket', details: (error as Error).message });
  }
});

/**
 * PUT /api/v1/tickets/:id
 * Update ticket
 */
app.put('/api/v1/tickets/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const ticket = database.tickets.find(t => t.id === req.params.id);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Update allowed fields
    const { title, description, priority, status } = req.body;

    if (title) ticket.title = title;
    if (description) ticket.description = description;
    if (priority) ticket.priority = priority;
    if (status) ticket.status = status;

    ticket.updated_at = new Date().toISOString();

    await flushTickets(database);

    res.json({
      message: 'Ticket updated successfully',
      ticket,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update ticket', details: (error as Error).message });
  }
});

/**
 * PATCH /api/v1/tickets/:id/assign
 * Assign ticket to user
 */
app.patch('/api/v1/tickets/:id/assign', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { assigned_to_user_id } = req.body;

    if (!assigned_to_user_id) {
      return res.status(400).json({ error: 'assigned_to_user_id required' });
    }

    const ticket = database.tickets.find(t => t.id === req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Verify user exists
    const user = database.users.find(u => u.id === assigned_to_user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    ticket.assigned_to_user_id = assigned_to_user_id;
    ticket.updated_at = new Date().toISOString();

    await flushTickets(database);

    res.json({
      message: 'Ticket assigned successfully',
      ticket,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to assign ticket', details: (error as Error).message });
  }
});

/**
 * DELETE /api/v1/tickets/:id
 * Delete ticket
 */
app.delete('/api/v1/tickets/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const ticketIndex = database.tickets.findIndex(t => t.id === req.params.id);

    if (ticketIndex === -1) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    database.tickets.splice(ticketIndex, 1);

    await flushTickets(database);

    res.json({ message: 'Ticket deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete ticket', details: (error as Error).message });
  }
});

/**
 * POST /api/v1/tickets/:id/comments
 * Add comment to ticket
 */
app.post('/api/v1/tickets/:id/comments', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { text, is_internal } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Comment text required' });
    }

    const ticket = database.tickets.find(t => t.id === req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const comment: Comment = {
      id: uuidv4(),
      ticket_id: ticket.id,
      user_id: req.userId!,
      text,
      is_internal: is_internal || false,
      created_at: new Date().toISOString(),
    };

    ticket.comments.push(comment);
    ticket.updated_at = new Date().toISOString();

    await flushTickets(database);

    res.status(201).json({
      message: 'Comment added successfully',
      comment,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add comment', details: (error as Error).message });
  }
});

// ============================================================================
// ROUTES: CUSTOMERS
// ============================================================================

/**
 * POST /api/v1/customers
 * Create new customer
 */
app.post('/api/v1/customers', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { account_number, first_name, last_name, email, account_type } = req.body;

    if (!account_number || !first_name || !last_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if account exists
    if (database.customers.find(c => c.account_number === account_number)) {
      return res.status(409).json({ error: 'Account number already exists' });
    }

    const customerId = uuidv4();
    const newCustomer: Customer = {
      id: customerId,
      account_number,
      first_name,
      last_name,
      email: email || '',
      account_type: account_type || 'shared_internet',
      created_at: new Date().toISOString(),
    };

    database.customers.push(newCustomer);

    await flushCustomers(database);

    res.status(201).json({
      message: 'Customer created successfully',
      customer: newCustomer,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create customer', details: (error as Error).message });
  }
});

/**
 * GET /api/v1/customers
 * Get all customers
 */
app.get('/api/v1/customers', authenticateToken, (req: AuthRequest, res: Response) => {
  try {
    res.json({
      count: database.customers.length,
      customers: database.customers,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customers', details: (error as Error).message });
  }
});

/**
 * GET /api/v1/customers/:id
 * Get customer details
 */
app.get('/api/v1/customers/:id', authenticateToken, (req: AuthRequest, res: Response) => {
  try {
    const customer = database.customers.find(c => c.id === req.params.id);

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get customer tickets
    const tickets = database.tickets.filter(t => t.customer_id === customer.id);

    res.json({
      customer,
      tickets,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customer', details: (error as Error).message });
  }
});

/**
 * DELETE /api/v1/customers/:id
 * Delete customer (and optionally their tickets)
 */
app.delete('/api/v1/customers/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const customer = database.customers.find(c => c.id === req.params.id);

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customerTickets = database.tickets.filter(t => t.customer_id === customer.id);
    const force = req.query.force === 'true';

    if (customerTickets.length > 0 && !force) {
      return res.status(409).json({ error: `Customer has ${customerTickets.length} existing tickets` });
    }

    // Delete associated tickets when force=true
    if (customerTickets.length > 0) {
      database.tickets = database.tickets.filter(t => t.customer_id !== customer.id);
      await flushTickets(database);
    }

    database.customers = database.customers.filter(c => c.id !== customer.id);

    await flushCustomers(database);

    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete customer', details: (error as Error).message });
  }
});

// ============================================================================
// ROUTES: USERS
// ============================================================================

/**
 * GET /api/v1/users
 * Get all users
 */
app.get('/api/v1/users', authenticateToken, (req: AuthRequest, res: Response) => {
  try {
    const users = database.users.map(u => ({
      id: u.id,
      email: u.email,
      first_name: u.first_name,
      last_name: u.last_name,
      role: u.role,
      is_active: u.is_active,
      created_at: u.created_at,
    }));

    res.json({
      count: users.length,
      users,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users', details: (error as Error).message });
  }
});

/**
 * GET /api/v1/users/:id
 * Get user details
 */
app.get('/api/v1/users/:id', authenticateToken, (req: AuthRequest, res: Response) => {
  try {
    const user = database.users.find(u => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user tickets
    const assignedTickets = database.tickets.filter(t => t.assigned_to_user_id === user.id);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        is_active: user.is_active,
        created_at: user.created_at,
      },
      tickets_assigned: assignedTickets.length,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user', details: (error as Error).message });
  }
});

/**
 * DELETE /api/v1/users/:id
 * Delete user (admin only)
 */
app.delete('/api/v1/users/:id', authenticateToken, requireRole('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const user = database.users.find(u => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting own account
    if (req.userId === user.id) {
      return res.status(403).json({ error: 'Cannot delete your own account' });
    }

    // Prevent deleting users with assigned tickets
    const assignedTickets = database.tickets.filter(t => t.assigned_to_user_id === user.id);
    if (assignedTickets.length > 0) {
      return res.status(409).json({ error: `User has ${assignedTickets.length} assigned tickets` });
    }

    database.users = database.users.filter(u => u.id !== user.id);

    await flushUsers(database);

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete user', details: (error as Error).message });
  }
});

// ============================================================================
// ROUTES: ANALYTICS
// ============================================================================

/**
 * GET /api/v1/analytics/dashboard
 * Get dashboard metrics
 */
app.get('/api/v1/analytics/dashboard', authenticateToken, (req: AuthRequest, res: Response) => {
  try {
    const totalTickets = database.tickets.length;
    const openTickets = database.tickets.filter(t => t.status === 'open').length;
    const closedTickets = database.tickets.filter(t => t.status === 'closed').length;
    const totalCustomers = database.customers.length;
    const totalUsers = database.users.length;

    const byPriority = {
      low: database.tickets.filter(t => t.priority === 'low').length,
      medium: database.tickets.filter(t => t.priority === 'medium').length,
      high: database.tickets.filter(t => t.priority === 'high').length,
      critical: database.tickets.filter(t => t.priority === 'critical').length,
    };

    const byStatus = {
      open: database.tickets.filter(t => t.status === 'open').length,
      in_progress: database.tickets.filter(t => t.status === 'in_progress').length,
      on_hold: database.tickets.filter(t => t.status === 'on_hold').length,
      resolved: database.tickets.filter(t => t.status === 'resolved').length,
      closed: database.tickets.filter(t => t.status === 'closed').length,
    };

    res.json({
      summary: {
        total_tickets: totalTickets,
        open_tickets: openTickets,
        closed_tickets: closedTickets,
        total_customers: totalCustomers,
        total_users: totalUsers,
      },
      by_priority: byPriority,
      by_status: byStatus,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard', details: (error as Error).message });
  }
});

// ============================================================================
// ROUTES: HEALTH & INFO
// ============================================================================

/**
 * GET /health
 * Health check
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    persistence: isPersistenceEnabled() ? 'postgresql' : 'IN-MEMORY ONLY (data will NOT survive restart)',
  });
});

/**
 * GET /api/v1/info
 * System info
 */
app.get('/api/v1/info', (req: Request, res: Response) => {
  res.json({
    name: 'ISP Ticketing System',
    version: '1.0.0',
    status: 'operational',
    database: {
      users: database.users.length,
      tickets: database.tickets.length,
      customers: database.customers.length,
    },
  });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    method: req.method,
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.PORT || 3001;

/**
 * Seed an initial admin when the user table is empty, so the system is usable
 * on first boot. Password is ADMIN_DEFAULT_PASSWORD from env, or a generated
 * one that is printed ONCE to stdout.
 */
async function seedAdminIfEmpty(): Promise<void> {
  if (database.users.length > 0) return;

  const email = process.env.ADMIN_EMAIL || 'admin@isp.local';
  const password =
    process.env.ADMIN_DEFAULT_PASSWORD && process.env.ADMIN_DEFAULT_PASSWORD.trim()
      ? process.env.ADMIN_DEFAULT_PASSWORD
      : crypto.randomBytes(12).toString('base64');

  const admin: User = {
    id: uuidv4(),
    email,
    password_hash: await hashPassword(password),
    first_name: 'System',
    last_name: 'Administrator',
    role: 'admin',
    is_active: true,
    created_at: new Date().toISOString(),
  };

  database.users.push(admin);
  await flushUsers(database);

  console.log('\n🔐 Seeded initial admin account:');
  console.log(`   Email:    ${email}`);
  console.log(`   Password: ${password}`);
  console.log('   (stored hashed; this password is shown only once)');
}

/**
 * Only bind the port when run as the entry point (`node dist/app.js`,
 * `ts-node src/app.ts`). When imported (tests, other modules) the app is
 * exported without binding, so supertest can drive it in-process.
 */
if (require.main === module) {
  (async () => {
    await initDatabase(database);
    await seedAdminIfEmpty();

    app.listen(PORT, () => {
      console.log(`\n✅ ISP Ticketing System Backend`);
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(
        `💾 Persistence: ${isPersistenceEnabled() ? 'PostgreSQL' : 'IN-MEMORY ONLY — data will NOT survive restart'}`
      );
      console.log(`📚 API Endpoints:`);
      console.log(`   - POST /api/v1/auth/register - Register new user (admin)`);
      console.log(`   - POST /api/v1/auth/login - Login user`);
      console.log(`   - GET  /api/v1/auth/me - Current user`);
      console.log(`   - POST /api/v1/tickets - Create ticket`);
      console.log(`   - GET  /api/v1/tickets - Get all tickets`);
      console.log(`   - GET  /api/v1/customers - Get all customers`);
      console.log(`   - GET  /api/v1/analytics/dashboard - Get dashboard`);
      console.log(`   - GET /health - Health check\n`);
    });
  })().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

// Flush writes and close the pool cleanly on shutdown.
process.on('SIGTERM', async () => {
  await closeDatabase();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await closeDatabase();
  process.exit(0);
});

/**
 * TEST-ONLY SEED HOOK.
 *
 * app.ts does not export the in-memory store, so the test suite cannot create
 * the first admin through the public API (registration is admin-gated now,
 * which is the whole point). This helper inserts a user directly and returns
 * a token, giving the suite a root account to exercise the rest of the API.
 *
 * It is a separate exported function, deliberately not wired to any route —
 * there is no HTTP path to it.
 */
export async function __seedUserForTests(
  email: string,
  password: string,
  first: string,
  last: string,
  role: 'admin' | 'team_lead' | 'specialist' | 'engineer'
): Promise<{ id: string; token: string }> {
  const id = uuidv4();
  database.users.push({
    id,
    email,
    password_hash: await hashPassword(password),
    first_name: first,
    last_name: last,
    role,
    is_active: true,
    created_at: new Date().toISOString(),
  });
  await flushUsers(database);
  return { id, token: createToken(id, role) };
}

export default app;
