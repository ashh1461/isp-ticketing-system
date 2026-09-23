-- ISP Support Ticketing System - PostgreSQL Database Schema
-- Version 1.0
-- Created for self-hosted deployment

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================================
-- ENUMS (Data Types)
-- ============================================================================

CREATE TYPE user_role AS ENUM ('specialist', 'team_lead', 'admin', 'engineer');
CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'on_hold', 'waiting_for_customer', 'waiting_for_dsp', 'resolved', 'closed', 'cancelled');
CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE account_type AS ENUM ('shared_internet', 'dedicated');
CREATE TYPE notification_type AS ENUM ('email', 'in_app', 'sms', 'slack');
CREATE TYPE notification_event AS ENUM ('ticket_assigned', 'ticket_reassigned', 'comment_added', 'priority_changed', 'sla_breach', 'ticket_closed', 'ticket_mentioned');
CREATE TYPE audit_action AS ENUM ('create', 'update', 'delete', 'status_change', 'assignment', 'comment', 'attachment', 'tag', 'escalate', 'archive');
CREATE TYPE incident_status AS ENUM ('declared', 'investigating', 'resolved', 'closed');
CREATE TYPE shift_type AS ENUM ('regular', 'oncall', 'off', 'holiday');
CREATE TYPE feedback_rating AS ENUM ('1', '2', '3', '4', '5');
CREATE TYPE automation_trigger_type AS ENUM ('on_create', 'on_status_change', 'on_priority_change', 'on_sla_breach', 'on_inactivity', 'on_customer_message', 'scheduled');
CREATE TYPE automation_action_type AS ENUM ('auto_assign', 'auto_close', 'auto_escalate', 'auto_notify', 'auto_response', 'status_change', 'priority_change');

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    role user_role NOT NULL DEFAULT 'specialist',
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP,
    password_expires_at TIMESTAMP,
    two_fa_enabled BOOLEAN DEFAULT FALSE,
    two_fa_secret VARCHAR(255),
    ldap_username VARCHAR(255),
    sso_provider VARCHAR(50),
    sso_id VARCHAR(255),
    preferences JSONB DEFAULT '{}',
    avatar_url VARCHAR(500),
    timezone VARCHAR(50) DEFAULT 'UTC',
    language VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP,
    CONSTRAINT email_not_deleted CHECK (deleted_at IS NULL OR email IS NOT NULL),
    UNIQUE(sso_provider, sso_id)
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_users_created_at ON users(created_at);

-- Roles Table
CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name user_role NOT NULL UNIQUE,
    description TEXT,
    is_system_role BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Permissions Table
CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_role_permission UNIQUE(role_id, permission_name)
);

CREATE INDEX idx_permissions_role_id ON permissions(role_id);

-- Customers Table
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_number VARCHAR(100) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    account_type account_type NOT NULL,
    billing_status VARCHAR(50) DEFAULT 'active',
    customer_since DATE,
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_customers_account_number ON customers(account_number);
CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_account_type ON customers(account_type);
CREATE INDEX idx_customers_created_at ON customers(created_at);

-- Customer Contacts Table (for multiple contact methods)
CREATE TABLE customer_contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    contact_type VARCHAR(50) NOT NULL, -- 'phone', 'email', 'whatsapp', 'sms'
    contact_value VARCHAR(255) NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customer_contacts_customer_id ON customer_contacts(customer_id);
CREATE INDEX idx_customer_contacts_type ON customer_contacts(contact_type);
CREATE UNIQUE INDEX idx_customer_primary_contact ON customer_contacts(customer_id, contact_type) 
    WHERE is_primary = TRUE;

-- Issue Categories Table
CREATE TABLE issue_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    icon_url VARCHAR(500),
    color VARCHAR(7),
    is_active BOOLEAN DEFAULT TRUE,
    is_system_category BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tickets Table
CREATE TABLE tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_number VARCHAR(50) UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    assigned_to_user_id UUID REFERENCES users(id),
    status ticket_status NOT NULL DEFAULT 'open',
    priority ticket_priority NOT NULL DEFAULT 'medium',
    issue_category_id UUID REFERENCES issue_categories(id),
    title VARCHAR(500),
    description TEXT NOT NULL,
    bundle_capacity VARCHAR(100),
    equipment_affected VARCHAR(500),
    service_line VARCHAR(100),
    estimated_resolution_time TIMESTAMP,
    sla_response_due TIMESTAMP,
    sla_resolution_due TIMESTAMP,
    resolved_at TIMESTAMP,
    closed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    is_escalated BOOLEAN DEFAULT FALSE,
    escalated_to_user_id UUID REFERENCES users(id),
    escalated_at TIMESTAMP,
    escalation_reason TEXT,
    channel VARCHAR(50), -- 'phone', 'whatsapp', 'sms', 'email', 'web'
    external_ticket_id VARCHAR(255), -- For channel integration reference
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP,
    CONSTRAINT ticket_not_deleted CHECK (deleted_at IS NULL),
    CONSTRAINT ticket_channel_validity CHECK (channel IN ('phone', 'whatsapp', 'sms', 'email', 'web'))
);

CREATE INDEX idx_tickets_ticket_number ON tickets(ticket_number);
CREATE INDEX idx_tickets_customer_id ON tickets(customer_id);
CREATE INDEX idx_tickets_assigned_to ON tickets(assigned_to_user_id);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_priority ON tickets(priority);
CREATE INDEX idx_tickets_category ON tickets(issue_category_id);
CREATE INDEX idx_tickets_created_at ON tickets(created_at);
CREATE INDEX idx_tickets_created_by ON tickets(created_by_user_id);
CREATE INDEX idx_tickets_escalated ON tickets(is_escalated);
CREATE INDEX idx_tickets_sla_resolution_due ON tickets(sla_resolution_due) 
    WHERE status NOT IN ('closed', 'resolved', 'cancelled');

-- Ticket Assignments History Table
CREATE TABLE ticket_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    assigned_to_user_id UUID NOT NULL REFERENCES users(id),
    assigned_by_user_id UUID NOT NULL REFERENCES users(id),
    assignment_reason VARCHAR(500),
    reassignments_count INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_assignments_ticket ON ticket_assignments(ticket_id),
    INDEX idx_assignments_user ON ticket_assignments(assigned_to_user_id)
);

-- Ticket Status Updates Table
CREATE TABLE ticket_updates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    updated_by_user_id UUID NOT NULL REFERENCES users(id),
    old_status ticket_status,
    new_status ticket_status,
    old_priority ticket_priority,
    new_priority ticket_priority,
    change_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_updates_ticket ON ticket_updates(ticket_id),
    INDEX idx_updates_user ON ticket_updates(updated_by_user_id),
    INDEX idx_updates_created_at ON ticket_updates(created_at)
);

-- Ticket Comments Table
CREATE TABLE ticket_comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    comment_text TEXT NOT NULL,
    is_internal BOOLEAN DEFAULT FALSE,
    is_system_comment BOOLEAN DEFAULT FALSE,
    mentions JSONB DEFAULT '[]', -- Array of user IDs mentioned
    edited_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_comments_ticket ON ticket_comments(ticket_id),
    INDEX idx_comments_user ON ticket_comments(user_id),
    INDEX idx_comments_internal ON ticket_comments(is_internal),
    INDEX idx_comments_created_at ON ticket_comments(created_at)
);

-- Ticket Attachments Table
CREATE TABLE ticket_attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    uploaded_by_user_id UUID NOT NULL REFERENCES users(id),
    file_name VARCHAR(500) NOT NULL,
    file_path VARCHAR(1000) NOT NULL,
    file_size BIGINT,
    mime_type VARCHAR(100),
    description TEXT,
    is_visible_to_customer BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP,
    INDEX idx_attachments_ticket ON ticket_attachments(ticket_id),
    INDEX idx_attachments_uploaded_by ON ticket_attachments(uploaded_by_user_id)
);

-- Ticket Tags Table
CREATE TABLE ticket_tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tag_name VARCHAR(100) NOT NULL,
    tag_color VARCHAR(7),
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_ticket_tag UNIQUE(ticket_id, tag_name),
    INDEX idx_tags_ticket ON ticket_tags(ticket_id),
    INDEX idx_tags_name ON ticket_tags(tag_name)
);

-- Predefined Tags Table
CREATE TABLE predefined_tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tag_name VARCHAR(100) NOT NULL UNIQUE,
    tag_color VARCHAR(7),
    description TEXT,
    usage_count INTEGER DEFAULT 0,
    is_system_tag BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- SLA & ESCALATION TABLES
-- ============================================================================

-- SLA Policies Table
CREATE TABLE sla_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    priority ticket_priority NOT NULL,
    response_time_minutes INTEGER NOT NULL,
    resolution_time_minutes INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_sla_priority UNIQUE(priority, is_active) 
        WHERE is_active = TRUE
);

-- Escalation Rules Table
CREATE TABLE escalation_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    trigger_type VARCHAR(50) NOT NULL, -- 'sla_breach', 'manual', 'age'
    trigger_condition JSONB NOT NULL,
    escalate_to_role user_role,
    escalate_to_user_id UUID REFERENCES users(id),
    notification_text TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- AUTOMATION & WORKFLOW TABLES
-- ============================================================================

-- Ticket Templates Table
CREATE TABLE ticket_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL UNIQUE,
    description TEXT,
    title_template VARCHAR(500),
    description_template TEXT,
    issue_category_id UUID REFERENCES issue_categories(id),
    default_priority ticket_priority DEFAULT 'medium',
    quick_actions JSONB DEFAULT '[]', -- Array of quick action templates
    tags JSONB DEFAULT '[]', -- Array of suggested tags
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    is_system_template BOOLEAN DEFAULT FALSE,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_templates_category ON ticket_templates(issue_category_id),
    INDEX idx_templates_created_at ON ticket_templates(created_at)
);

-- Canned Responses Table
CREATE TABLE canned_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL UNIQUE,
    description TEXT,
    response_text TEXT NOT NULL,
    issue_category_id UUID REFERENCES issue_categories(id),
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    is_system_response BOOLEAN DEFAULT FALSE,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Automation Rules Table
CREATE TABLE automation_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL UNIQUE,
    description TEXT,
    trigger_type automation_trigger_type NOT NULL,
    trigger_conditions JSONB NOT NULL,
    action_type automation_action_type NOT NULL,
    action_config JSONB NOT NULL,
    priority INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_system_rule BOOLEAN DEFAULT FALSE,
    execution_count INTEGER DEFAULT 0,
    last_executed_at TIMESTAMP,
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_automation_active ON automation_rules(is_active),
    INDEX idx_automation_trigger ON automation_rules(trigger_type)
);

-- Automation Execution Log Table
CREATE TABLE automation_execution_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    automation_rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL, -- 'success', 'failed', 'skipped'
    result_data JSONB,
    error_message TEXT,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_execution_rule ON automation_execution_log(automation_rule_id),
    INDEX idx_execution_ticket ON automation_execution_log(ticket_id),
    INDEX idx_execution_status ON automation_execution_log(status),
    INDEX idx_execution_executed_at ON automation_execution_log(executed_at)
);

-- Scheduled Actions Table
CREATE TABLE scheduled_actions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    automation_rule_id UUID REFERENCES automation_rules(id) ON DELETE CASCADE,
    scheduled_for TIMESTAMP NOT NULL,
    action_data JSONB NOT NULL,
    is_executed BOOLEAN DEFAULT FALSE,
    executed_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_scheduled_for ON scheduled_actions(scheduled_for),
    INDEX idx_scheduled_executed ON scheduled_actions(is_executed)
);

-- ============================================================================
-- NOTIFICATION & COMMUNICATION TABLES
-- ============================================================================

-- Notification Preferences Table
CREATE TABLE notification_preferences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    ticket_assigned BOOLEAN DEFAULT TRUE,
    ticket_reassigned BOOLEAN DEFAULT TRUE,
    comment_added BOOLEAN DEFAULT TRUE,
    priority_changed BOOLEAN DEFAULT TRUE,
    sla_breach BOOLEAN DEFAULT TRUE,
    ticket_closed BOOLEAN DEFAULT TRUE,
    ticket_mentioned BOOLEAN DEFAULT TRUE,
    notification_type notification_type DEFAULT 'email',
    digest_frequency VARCHAR(50) DEFAULT 'immediate', -- 'immediate', 'daily', 'weekly'
    quiet_hours_start TIME,
    quiet_hours_end TIME,
    quiet_hours_enabled BOOLEAN DEFAULT FALSE,
    email_notifications BOOLEAN DEFAULT TRUE,
    in_app_notifications BOOLEAN DEFAULT TRUE,
    sms_notifications BOOLEAN DEFAULT FALSE,
    slack_notifications BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notifications Table
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type notification_event NOT NULL,
    ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    message TEXT,
    actor_user_id UUID REFERENCES users(id),
    notification_type notification_type DEFAULT 'in_app',
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days',
    INDEX idx_notifications_user ON notifications(user_id),
    INDEX idx_notifications_ticket ON notifications(ticket_id),
    INDEX idx_notifications_read ON notifications(is_read),
    INDEX idx_notifications_created_at ON notifications(created_at)
);

-- Email Log Table
CREATE TABLE email_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    to_email VARCHAR(255) NOT NULL,
    from_email VARCHAR(255) NOT NULL,
    subject VARCHAR(500),
    body TEXT,
    ticket_id UUID REFERENCES tickets(id),
    sent_by_user_id UUID REFERENCES users(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'sent', 'failed', 'bounced'
    sent_at TIMESTAMP,
    failed_reason TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email_ticket ON email_log(ticket_id),
    INDEX idx_email_status ON email_log(status),
    INDEX idx_email_created_at ON email_log(created_at)
);

-- ============================================================================
-- KNOWLEDGE BASE & FEEDBACK TABLES
-- ============================================================================

-- Knowledge Base Articles Table
CREATE TABLE kb_articles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(500) UNIQUE NOT NULL,
    content TEXT NOT NULL,
    excerpt VARCHAR(1000),
    issue_category_id UUID REFERENCES issue_categories(id),
    author_id UUID NOT NULL REFERENCES users(id),
    is_published BOOLEAN DEFAULT FALSE,
    is_internal_only BOOLEAN DEFAULT FALSE,
    views_count INTEGER DEFAULT 0,
    helpful_count INTEGER DEFAULT 0,
    unhelpful_count INTEGER DEFAULT 0,
    tags JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP,
    INDEX idx_kb_slug ON kb_articles(slug),
    INDEX idx_kb_published ON kb_articles(is_published),
    INDEX idx_kb_category ON kb_articles(issue_category_id),
    INDEX idx_kb_created_at ON kb_articles(created_at),
    INDEX idx_kb_title_search ON kb_articles USING GIN(to_tsvector('english', title || ' ' || content))
);

-- Feedback Surveys Table
CREATE TABLE feedback_surveys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    satisfaction_rating feedback_rating,
    specialist_id UUID REFERENCES users(id),
    specialist_rating feedback_rating,
    resolution_quality_rating feedback_rating,
    response_time_rating feedback_rating,
    comments TEXT,
    would_recommend BOOLEAN,
    nps_score INTEGER, -- Net Promoter Score 0-10
    email_sent_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_feedback_ticket ON feedback_surveys(ticket_id),
    INDEX idx_feedback_customer ON feedback_surveys(customer_id),
    INDEX idx_feedback_completed ON feedback_surveys(completed_at),
    INDEX idx_feedback_created_at ON feedback_surveys(created_at)
);

-- ============================================================================
-- TIME TRACKING & SHIFT MANAGEMENT TABLES
-- ============================================================================

-- Time Tracking Table
CREATE TABLE time_tracking (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    duration_minutes INTEGER,
    time_entry_type VARCHAR(50) DEFAULT 'automatic', -- 'automatic', 'manual'
    is_billable BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_time_ticket ON time_tracking(ticket_id),
    INDEX idx_time_user ON time_tracking(user_id),
    INDEX idx_time_billable ON time_tracking(is_billable),
    INDEX idx_time_created_at ON time_tracking(created_at)
);

-- Shift Schedules Table
CREATE TABLE shift_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shift_date DATE NOT NULL,
    shift_type shift_type NOT NULL DEFAULT 'regular',
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_oncall BOOLEAN DEFAULT FALSE,
    oncall_level INTEGER, -- For escalation level
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_shift UNIQUE(user_id, shift_date),
    INDEX idx_shift_user ON shift_schedules(user_id),
    INDEX idx_shift_date ON shift_schedules(shift_date),
    INDEX idx_shift_oncall ON shift_schedules(is_oncall),
    INDEX idx_shift_type ON shift_schedules(shift_type)
);

-- Oncall Rotations Table
CREATE TABLE oncall_rotations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    level INTEGER NOT NULL, -- Escalation level
    rotation_users JSONB NOT NULL, -- Array of user IDs in rotation order
    current_index INTEGER DEFAULT 0,
    rotation_interval_days INTEGER DEFAULT 7,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- INCIDENT & PROBLEM MANAGEMENT TABLES
-- ============================================================================

-- Incidents Table
CREATE TABLE incidents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    incident_number VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    status incident_status NOT NULL DEFAULT 'declared',
    severity VARCHAR(50) NOT NULL, -- 'low', 'medium', 'high', 'critical'
    declared_by_user_id UUID NOT NULL REFERENCES users(id),
    declared_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    closed_at TIMESTAMP,
    root_cause TEXT,
    resolution_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_incidents_status ON incidents(status),
    INDEX idx_incidents_severity ON incidents(severity),
    INDEX idx_incidents_declared_at ON incidents(declared_at)
);

-- Incident Tickets Table (Linking tickets to incidents)
CREATE TABLE incident_tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_incident_ticket UNIQUE(incident_id, ticket_id)
);

-- Problems Table
CREATE TABLE problems (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    problem_number VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    root_cause TEXT,
    affected_category_id UUID REFERENCES issue_categories(id),
    related_tickets_count INTEGER DEFAULT 0,
    is_resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP,
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_problems_resolved ON problems(is_resolved),
    INDEX idx_problems_created_at ON problems(created_at)
);

-- Problem Tickets Table
CREATE TABLE problem_tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_problem_ticket UNIQUE(problem_id, ticket_id)
);

-- ============================================================================
-- AUDIT & COMPLIANCE TABLES
-- ============================================================================

-- Audit Log Table
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action audit_action NOT NULL,
    entity_type VARCHAR(50) NOT NULL, -- 'ticket', 'user', 'settings', etc.
    entity_id VARCHAR(255),
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    status VARCHAR(50) DEFAULT 'success', -- 'success', 'failed', 'unauthorized'
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_user ON audit_log(user_id),
    INDEX idx_audit_action ON audit_log(action),
    INDEX idx_audit_entity ON audit_log(entity_type, entity_id),
    INDEX idx_audit_created_at ON audit_log(created_at),
    INDEX idx_audit_status ON audit_log(status)
);

-- ============================================================================
-- ARCHIVING & BACKUP TABLES
-- ============================================================================

-- Archived Tickets Table (Metadata only)
CREATE TABLE archived_tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    original_ticket_id UUID NOT NULL,
    ticket_number VARCHAR(50) NOT NULL,
    archive_format VARCHAR(50) NOT NULL, -- 'pdf', 'csv', 'json', 'xlsx', 'txt'
    archive_path VARCHAR(1000) NOT NULL,
    archive_file_size BIGINT,
    archive_checksum VARCHAR(64),
    is_compressed BOOLEAN DEFAULT FALSE,
    sftp_server VARCHAR(255),
    sftp_path VARCHAR(1000),
    archived_by_user_id UUID REFERENCES users(id),
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    retention_expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '7 years',
    is_searchable BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    INDEX idx_archived_original_id ON archived_tickets(original_ticket_id),
    INDEX idx_archived_ticket_number ON archived_tickets(ticket_number),
    INDEX idx_archived_at ON archived_tickets(archived_at),
    INDEX idx_archived_expires_at ON archived_tickets(retention_expires_at)
);

-- Backup Log Table
CREATE TABLE backup_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    backup_type VARCHAR(50) NOT NULL, -- 'full', 'incremental'
    backup_path VARCHAR(1000) NOT NULL,
    backup_size BIGINT,
    backup_checksum VARCHAR(64),
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'success', 'failed', 'verified'
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    verified_at TIMESTAMP,
    error_message TEXT,
    retention_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_backup_status ON backup_log(status),
    INDEX idx_backup_created_at ON backup_log(created_at),
    INDEX idx_backup_retention ON backup_log(retention_until)
);

-- ============================================================================
-- CONFIGURATION & SETTINGS TABLES
-- ============================================================================

-- System Settings Table
CREATE TABLE system_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    setting_key VARCHAR(255) UNIQUE NOT NULL,
    setting_value JSONB NOT NULL,
    data_type VARCHAR(50), -- 'string', 'integer', 'boolean', 'json'
    description TEXT,
    is_system_setting BOOLEAN DEFAULT FALSE,
    updated_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_settings_key ON system_settings(setting_key)
);

-- Feature Flags Table
CREATE TABLE feature_flags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flag_name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    is_enabled BOOLEAN DEFAULT FALSE,
    is_system_flag BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_flags_enabled ON feature_flags(is_enabled)
);

-- ============================================================================
-- SESSION & SECURITY TABLES
-- ============================================================================

-- Sessions Table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    device_info JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_user ON sessions(user_id),
    INDEX idx_sessions_expires ON sessions(expires_at),
    INDEX idx_sessions_revoked ON sessions(revoked_at)
);

-- Failed Login Attempts Table
CREATE TABLE failed_login_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email_or_username VARCHAR(255),
    ip_address VARCHAR(45),
    attempt_reason VARCHAR(100),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_login_attempts_ip ON failed_login_attempts(ip_address),
    INDEX idx_login_attempts_created ON failed_login_attempts(created_at)
);

-- ============================================================================
-- CHANNEL INTEGRATION TABLES
-- ============================================================================

-- Channel Integrations Table
CREATE TABLE channel_integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_type VARCHAR(50) NOT NULL, -- 'whatsapp', 'sms', 'email', 'slack'
    channel_name VARCHAR(100) NOT NULL,
    is_enabled BOOLEAN DEFAULT TRUE,
    api_key_encrypted VARCHAR(500),
    api_secret_encrypted VARCHAR(500),
    webhook_url VARCHAR(1000),
    webhook_secret VARCHAR(255),
    configuration JSONB DEFAULT '{}',
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_channel UNIQUE(channel_type, channel_name)
);

-- Channel Messages Log Table
CREATE TABLE channel_messages_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    channel_type VARCHAR(50) NOT NULL,
    message_direction VARCHAR(20) NOT NULL, -- 'inbound', 'outbound'
    sender_id VARCHAR(255),
    recipient_id VARCHAR(255),
    message_content TEXT,
    message_metadata JSONB,
    external_message_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'received', -- 'received', 'sent', 'failed', 'delivered', 'read'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_channel_messages_ticket ON channel_messages_log(ticket_id),
    INDEX idx_channel_messages_channel ON channel_messages_log(channel_type),
    INDEX idx_channel_messages_created ON channel_messages_log(created_at)
);

-- ============================================================================
-- VIEWS (For commonly used queries)
-- ============================================================================

-- Open Tickets View
CREATE VIEW open_tickets AS
SELECT 
    t.id,
    t.ticket_number,
    t.title,
    t.priority,
    t.status,
    t.assigned_to_user_id,
    u.first_name,
    u.last_name,
    c.account_number,
    t.created_at,
    t.sla_resolution_due,
    CASE 
        WHEN t.sla_resolution_due < NOW() THEN true 
        ELSE false 
    END as sla_breached
FROM tickets t
LEFT JOIN users u ON t.assigned_to_user_id = u.id
LEFT JOIN customers c ON t.customer_id = c.id
WHERE t.status IN ('open', 'in_progress', 'on_hold');

-- Specialist Performance View
CREATE VIEW specialist_performance AS
SELECT 
    u.id,
    u.first_name,
    u.last_name,
    COUNT(t.id) as total_tickets_handled,
    COUNT(CASE WHEN t.status = 'closed' THEN 1 END) as closed_tickets,
    COUNT(CASE WHEN t.status = 'resolved' THEN 1 END) as resolved_tickets,
    AVG(EXTRACT(EPOCH FROM (COALESCE(t.closed_at, t.resolved_at) - t.created_at))/3600) as avg_resolution_hours,
    COUNT(CASE WHEN t.sla_resolution_due < COALESCE(t.closed_at, t.resolved_at) THEN 1 END) as sla_breaches,
    ROUND(AVG(fs.satisfaction_rating::numeric), 2) as avg_satisfaction_rating
FROM users u
LEFT JOIN tickets t ON u.id = t.assigned_to_user_id
LEFT JOIN feedback_surveys fs ON t.id = fs.ticket_id
WHERE u.role = 'specialist'
GROUP BY u.id, u.first_name, u.last_name;

-- SLA Compliance View
CREATE VIEW sla_compliance AS
SELECT 
    EXTRACT(DATE FROM t.created_at) as date,
    t.priority,
    COUNT(*) as total_tickets,
    COUNT(CASE 
        WHEN COALESCE(t.closed_at, t.resolved_at) <= sp.resolution_time_minutes * INTERVAL '1 minute' + t.created_at 
        THEN 1 
    END) as sla_compliant,
    ROUND(100.0 * COUNT(CASE 
        WHEN COALESCE(t.closed_at, t.resolved_at) <= sp.resolution_time_minutes * INTERVAL '1 minute' + t.created_at 
        THEN 1 
    END) / COUNT(*), 2) as compliance_percentage
FROM tickets t
JOIN sla_policies sp ON t.priority = sp.priority
WHERE t.status IN ('closed', 'resolved')
GROUP BY EXTRACT(DATE FROM t.created_at), t.priority;

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Function to generate ticket number
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS VARCHAR AS $$
BEGIN
    RETURN 'TKT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD((NEXTVAL('ticket_sequence'))::text, 6, '0');
END;
$$ LANGUAGE plpgsql;

CREATE SEQUENCE ticket_sequence START WITH 1000;

-- Trigger to update ticket updated_at timestamp
CREATE OR REPLACE FUNCTION update_ticket_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_update_timestamp
BEFORE UPDATE ON tickets
FOR EACH ROW
EXECUTE FUNCTION update_ticket_timestamp();

-- Trigger to log audit actions for tickets
CREATE OR REPLACE FUNCTION audit_ticket_changes()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_log (
        user_id, 
        action, 
        entity_type, 
        entity_id, 
        old_values, 
        new_values,
        status
    ) VALUES (
        CURRENT_USER_ID(),
        CASE 
            WHEN TG_OP = 'INSERT' THEN 'create'
            WHEN TG_OP = 'UPDATE' THEN 'update'
            WHEN TG_OP = 'DELETE' THEN 'delete'
        END,
        'ticket',
        NEW.id::text,
        CASE WHEN TG_OP = 'UPDATE' THEN row_to_json(OLD) ELSE NULL END,
        CASE WHEN TG_OP != 'DELETE' THEN row_to_json(NEW) ELSE NULL END,
        'success'
    );
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_ticket_changes_trigger
AFTER INSERT OR UPDATE OR DELETE ON tickets
FOR EACH ROW
EXECUTE FUNCTION audit_ticket_changes();

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Full-text search indexes
CREATE INDEX idx_tickets_fts ON tickets USING GIN(to_tsvector('english', 
    COALESCE(title, '') || ' ' || COALESCE(description, '')));

CREATE INDEX idx_customers_fts ON customers USING GIN(to_tsvector('english', 
    COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' || COALESCE(email, '')));

-- Composite indexes for common queries
CREATE INDEX idx_tickets_assigned_status ON tickets(assigned_to_user_id, status);
CREATE INDEX idx_tickets_customer_status ON tickets(customer_id, status);
CREATE INDEX idx_tickets_priority_status ON tickets(priority, status);
CREATE INDEX idx_tickets_category_status ON tickets(issue_category_id, status);

-- Partial indexes for common filters
CREATE INDEX idx_tickets_open ON tickets(created_at) WHERE status IN ('open', 'in_progress', 'on_hold');
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

-- ============================================================================
-- INITIAL DATA
-- ============================================================================

-- Insert system roles
INSERT INTO roles (name, description, is_system_role) VALUES
    ('specialist', 'Support specialist - handles tickets', TRUE),
    ('team_lead', 'Team lead - manages specialists and escalations', TRUE),
    ('admin', 'System administrator - full access', TRUE),
    ('engineer', 'Technical engineer - advanced support', TRUE)
ON CONFLICT (name) DO NOTHING;

-- Insert default issue categories
INSERT INTO issue_categories (name, description, is_system_category) VALUES
    ('Internet Issue', 'Broadband connectivity problems', TRUE),
    ('Phone Service', 'Voice/phone line issues', TRUE),
    ('Email Setup', 'Email configuration problems', TRUE),
    ('Router Issues', 'Hardware or router configuration', TRUE),
    ('Billing', 'Billing and account questions', TRUE),
    ('Account Management', 'Account changes and updates', TRUE),
    ('Technical Support', 'General technical support', TRUE),
    ('Service Upgrade', 'Upgrading service plan', TRUE),
    ('Service Downgrade', 'Downgrading service plan', TRUE),
    ('Outage Report', 'Service outage report', TRUE)
ON CONFLICT (name) DO NOTHING;

-- Insert default SLA policies
INSERT INTO sla_policies (name, priority, response_time_minutes, resolution_time_minutes, is_default) VALUES
    ('Critical SLA', 'critical', 15, 240, FALSE),
    ('High SLA', 'high', 30, 480, FALSE),
    ('Medium SLA', 'medium', 60, 1440, TRUE),
    ('Low SLA', 'low', 240, 2880, FALSE)
ON CONFLICT DO NOTHING;

-- Insert default feature flags
INSERT INTO feature_flags (flag_name, description, is_enabled, is_system_flag) VALUES
    ('customer_portal', 'Enable customer self-service portal', FALSE, TRUE),
    ('whatsapp_integration', 'Enable WhatsApp channel integration', FALSE, TRUE),
    ('sms_integration', 'Enable SMS channel integration', FALSE, TRUE),
    ('slack_notifications', 'Enable Slack notifications', FALSE, TRUE),
    ('incidents_management', 'Enable incident management', TRUE, TRUE),
    ('problems_management', 'Enable problem management', TRUE, TRUE),
    ('ai_suggestions', 'Enable AI-powered suggestions', FALSE, TRUE),
    ('multi_language', 'Enable multi-language support', TRUE, TRUE),
    ('compliance_features', 'Enable compliance features (GDPR, etc)', FALSE, TRUE),
    ('plugin_system', 'Enable plugin/extension system', FALSE, TRUE)
ON CONFLICT (flag_name) DO NOTHING;

-- ============================================================================
-- SCHEMA VERSION
-- ============================================================================

INSERT INTO system_settings (setting_key, setting_value, data_type, description, is_system_setting) VALUES
    ('schema_version', '"1.0"', 'string', 'Current database schema version', TRUE),
    ('last_migration', to_jsonb(NOW()), 'json', 'Timestamp of last migration', TRUE)
ON CONFLICT (setting_key) DO NOTHING;

-- End of schema
