'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createOrganizationAction,
  createProjectAction,
  importProjectAction,
  loginAction,
  logoutAction,
  revealProjectCredentialsAction,
  setupAdminAction,
} from '@/app/actions';

type Screen = 'dashboard' | 'wizard' | 'import' | 'deployment' | 'credentials' | 'setup' | 'login';
type WizardStep = 1 | 2 | 3;

export type OrganizationSummary = { id: string; name: string; initials: string; role: string };
export type ProjectSummary = {
  id: string;
  organizationId: string;
  name: string;
  status: string;
  ownership: 'manager-owned' | 'external';
  publicUrl: string;
  apiPort: number;
  databaseSessionPort: number;
  databaseTransactionPort: number;
  release: string;
};
export type ActiveJobSummary = {
  id: string;
  projectId: string | null;
  status: string;
  stage: string | null;
  errorMessage: string | null;
  events: Array<{ sequence: number; stage: string | null; level: string; message: string; createdAt: string }>;
};
export type ManagerShellProps = {
  initialScreen: Screen;
  user: { displayName: string; email: string } | null;
  organizations: OrganizationSummary[];
  projects: ProjectSummary[];
  activeJob?: ActiveJobSummary;
};

const stages = [
  ['✓', 'Configuration validated', 'Ports and secrets are ready'],
  ['✓', 'Creating project volumes', '9 isolated named volumes planned'],
  ['◌', 'Starting Supabase services', 'Waiting for database health check'],
  ['○', 'Running functional checks', 'Pending service startup'],
  ['○', 'Ready', 'Project will appear when all checks pass'],
] as const;

function Mark({ children }: { children: React.ReactNode }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

function Brand() {
  return <div className="brand-lockup"><span className="brand-mark">⌁</span><span>Supabase Manager</span></div>;
}

function AuthScreen({ mode }: { mode: 'setup' | 'login' }) {
  const setup = mode === 'setup';
  const [state, formAction, pending] = useActionState(setup ? setupAdminAction : loginAction, {});
  const [showPassword, setShowPassword] = useState(false);
  return (
    <main className="auth-screen">
      <section className="auth-form-panel">
        <header className="auth-brand"><Brand /></header>
        <div className="auth-form-wrap">
          <form className="auth-card" action={formAction}>
            <h1>{setup ? 'Set up Studio' : 'Welcome back'}</h1>
            <p>{setup ? 'Create your admin account and first organization to get started.' : 'Sign in to manage your organizations and Supabase projects.'}</p>
            {setup && <div className="field"><label htmlFor="setup-display-name">Full name</label><input id="setup-display-name" name="displayName" autoComplete="name" placeholder="Alex Morgan" required /></div>}
            {setup && <div className="field"><label htmlFor="setup-organization-name">Organization name</label><input id="setup-organization-name" name="organizationName" defaultValue="Default Organization" autoComplete="organization" required /></div>}
            <div className="field"><label htmlFor="manager-email">Email</label><input id="manager-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></div>
            <div className="field"><label htmlFor="manager-password">Password</label><div className="input-wrap"><input id="manager-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={setup ? 'new-password' : 'current-password'} placeholder={setup ? 'Min. 12 characters' : 'Your password'} required /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? 'Hide' : 'Show'}</button></div></div>
            {setup && <div className="field"><label htmlFor="setup-confirm-password">Confirm password</label><input id="setup-confirm-password" name="confirmPassword" type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="Repeat your password" required /></div>}
            {state.error && <div className="form-error" role="alert">{state.error}</div>}
            <button className="btn btn-primary btn-wide" disabled={pending}>{pending ? 'Please wait…' : setup ? 'Create admin account' : 'Sign in'}</button>
          </form>
        </div>
        <footer className="auth-footer">Self-hosted control plane for official Supabase stacks.</footer>
      </section>
      <aside className="auth-hero" aria-label="Supabase Manager">
        <a className="auth-docs" href="https://github.com/skuldgerry/supabase-manager" target="_blank" rel="noreferrer">Documentation</a>
        <div className="auth-hero-content">
          <span className="auth-hero-mark" aria-hidden="true">⌁</span>
          <h2>Supabase Manager</h2>
          <p>Self-hosted, multi-organization Supabase Studio.<br />Manage isolated official stacks from one interface.</p>
        </div>
      </aside>
    </main>
  );
}

function Sidebar({ screen, setScreen, organization, user, onOrgMenu }: { screen: Screen; setScreen: (screen: Screen) => void; organization: OrganizationSummary; user: NonNullable<ManagerShellProps['user']>; onOrgMenu: () => void }) {
  const initials = user.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
  return (
    <aside className="sidebar">
      <Brand />
      <button className="workspace-switcher" onClick={onOrgMenu}>
        <span className="org-avatar">{organization.initials}</span><span><span className="workspace-name">{organization.name}</span><span className="workspace-role">{organization.role}</span></span><span className="chevron">⌄</span>
      </button>
      <nav className="nav-section">
        <div className="nav-label">Workspace</div>
        <button className={`nav-item ${screen === 'dashboard' ? 'active' : ''}`} onClick={() => setScreen('dashboard')}><Mark>▦</Mark><span>Projects</span></button>
        <button className={`nav-item ${screen === 'credentials' ? 'active' : ''}`} onClick={() => setScreen('credentials')}><Mark>⌘</Mark><span>Credentials</span></button>
      </nav>
      <nav className="nav-section">
        <div className="nav-label">Manage</div>
        <button className="nav-item" onClick={() => setScreen('dashboard')}><Mark>◌</Mark><span>Activity</span></button>
        <button className="nav-item" onClick={() => setScreen('dashboard')}><Mark>⚙</Mark><span>Organization settings</span></button>
      </nav>
      <div className="sidebar-footer">
        <div className="user-row"><span className="user-avatar">{initials}</span><div><strong>{user.displayName}</strong><span>{user.email}</span></div></div>
        <form action={logoutAction}><button className="nav-item"><Mark>↪</Mark><span>Sign out</span></button></form>
      </div>
    </aside>
  );
}

function Topbar({ title, organization, user, onHelp }: { title: string; organization: OrganizationSummary; user: NonNullable<ManagerShellProps['user']>; onHelp: () => void }) {
  const initials = user.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
  return <header className="topbar"><div className="breadcrumbs"><span>{organization.name}</span><span className="slash">/</span><strong>{title}</strong></div><div className="top-actions"><button className="icon-btn" aria-label="Help" onClick={onHelp}>?</button><button className="icon-btn" aria-label="Notifications">♢</button><span className="user-avatar">{initials}</span></div></header>;
}

function Dashboard({ organization, projects, onCreate, onImport, onSelect }: { organization: OrganizationSummary; projects: ProjectSummary[]; onCreate: () => void; onImport: () => void; onSelect: (projectId: string) => void }) {
  return <>
    <div className="page-heading cloud-heading"><div><h1>Projects</h1><p>Manage your self-hosted Supabase projects in {organization.name}.</p></div><div style={{ display: 'flex', gap: 9 }}><button className="btn btn-secondary" onClick={onImport}>＋ Import project</button><button className="btn btn-primary" onClick={onCreate}>＋ New project</button></div></div>
    {projects.length === 0 ? <section className="section-card"><div className="empty-state"><div className="empty-graphic">⌁</div><h2>No projects yet</h2><p>Create an isolated official Supabase stack or adopt an existing self-hosted project without touching its Docker resources.</p><div style={{ display: 'flex', justifyContent: 'center', gap: 9 }}><button className="btn btn-primary" onClick={onCreate}>Create a new project</button><button className="btn btn-secondary" onClick={onImport}>Import existing project</button></div></div></section> : <div className="project-grid">{projects.map((project) => {
      const ready = project.status === 'ready';
      return <article className="cloud-project-card" key={project.id}>
        <div className="project-card-body"><div className="project-card-title"><span className={`health-dot ${project.status === 'failed' ? 'red' : ready ? '' : 'amber'}`} /><h2>{project.name}</h2><button className="card-menu" aria-label={`Actions for ${project.name}`} onClick={() => onSelect(project.id)}>•••</button></div><div className="project-card-meta"><span className={`project-badge ${project.status === 'failed' ? 'red' : ready ? '' : 'amber'}`}>{project.status}</span><span className="project-badge">{project.ownership === 'external' ? 'External' : 'Manager-owned'}</span><code>{project.id.slice(0, 8)}</code></div><div className="service-list"><div><span className="health-dot" />API / {project.release.startsWith('self-hosted/v0.7.') ? 'Kong' : 'Envoy'} <code>:{project.apiPort}</code></div><div><span className="health-dot" />Session pooler <code>:{project.databaseSessionPort}</code></div><div><span className="health-dot" />Transaction pooler <code>:{project.databaseTransactionPort}</code></div><div><span className="release-dot" />{project.release}</div></div></div>
        <div className="project-card-footer"><button className="btn btn-secondary" disabled={!ready} onClick={() => window.open(project.publicUrl, '_blank', 'noopener,noreferrer')}>Open Studio</button><button className="btn btn-secondary" onClick={() => onSelect(project.id)}>Credentials</button></div>
      </article>;
    })}</div>}
  </>;
}

function ImportProject({ organization, onCancel }: { organization: OrganizationSummary; onCancel: () => void }) {
  const [state, formAction, pending] = useActionState(importProjectAction, {});
  return <div className="wizard-shell">
    <div className="page-heading"><div><div className="eyebrow">Import project</div><h1>Adopt an existing Supabase stack</h1><p>Register a running self-hosted project. The manager will not create, stop, or delete its Docker resources.</p></div></div>
    <section className="wizard-panel">
      <form action={formAction}>
        <input type="hidden" name="organizationId" value={organization.id} />
        <h2>Project connection</h2><p>Use the public gateway URL and the database connection details exposed by the existing stack.</p>
        <div className="form-grid">
          <div className="field"><label htmlFor="import-name">Project name</label><input id="import-name" name="name" placeholder="Customer portal" required /></div>
          <div className="field"><label htmlFor="import-release">Supabase release tag</label><input id="import-release" name="supabaseRelease" defaultValue="self-hosted/v0.8.0" required /></div>
          <div className="field"><label htmlFor="import-api-url">API / gateway URL</label><input id="import-api-url" name="apiUrl" type="url" placeholder="https://supabase.example.com" required /></div>
          <div className="field"><label htmlFor="import-site-url">Site URL (optional)</label><input id="import-site-url" name="siteUrl" type="url" placeholder="https://app.example.com" /></div>
          <div className="field"><label htmlFor="import-db-host">Database host</label><input id="import-db-host" name="dbHost" placeholder="db.example.com" required /></div>
          <div className="field"><label htmlFor="import-db-port">PostgreSQL port</label><input id="import-db-port" name="dbPort" type="number" defaultValue="5432" min="1" max="65535" required /></div>
          <div className="field"><label htmlFor="import-session-port">Session pooler port</label><input id="import-session-port" name="databaseSessionPort" type="number" placeholder="5432" min="1" max="65535" required /></div>
          <div className="field"><label htmlFor="import-transaction-port">Transaction pooler port</label><input id="import-transaction-port" name="databaseTransactionPort" type="number" placeholder="6543" min="1" max="65535" required /></div>
        </div>
        <h2 style={{ marginTop: 25 }}>Credentials</h2><p>These values are encrypted before persistence and are never sent to Docker or written to job events.</p>
        <div className="form-grid">
          <div className="field"><label htmlFor="import-dashboard-user">Studio username</label><input id="import-dashboard-user" name="dashboardUsername" defaultValue="supabase" required /></div>
          <div className="field"><label htmlFor="import-dashboard-password">Studio password</label><input id="import-dashboard-password" name="dashboardPassword" type="password" minLength={12} required /></div>
          <div className="field"><label htmlFor="import-postgres-password">PostgreSQL password</label><input id="import-postgres-password" name="postgresPassword" type="password" minLength={12} required /></div>
          <div className="field"><label htmlFor="import-jwt">JWT secret</label><input id="import-jwt" name="jwtSecret" type="password" minLength={32} required /></div>
          <div className="field"><label htmlFor="import-anon">ANON_KEY</label><input id="import-anon" name="anonKey" className="mono" required /></div>
          <div className="field"><label htmlFor="import-service">SERVICE_ROLE_KEY</label><input id="import-service" name="serviceRoleKey" className="mono" required /></div>
          <div className="field"><label htmlFor="import-publishable">Publishable key (optional)</label><input id="import-publishable" name="publishableKey" className="mono" /></div>
          <div className="field"><label htmlFor="import-secret">Secret key (optional)</label><input id="import-secret" name="secretKey" className="mono" /></div>
        </div>
        <div className="security-note">Connectivity is not probed by the manager broker because user-supplied endpoints must not be used for server-side network probing. Confirm the endpoint from the imported project before registering it.</div>
        {state.error && <div className="form-error form-error-spaced" role="alert">{state.error}</div>}
        <div className="wizard-footer"><button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button><button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Registering…' : 'Import project'}</button></div>
      </form>
    </section>
  </div>;
}

type WizardOptions = {
  managerPublicUrl: string;
  releases: string[];
  latestRelease: string;
  suggested: { api: number; dbSession: number; dbTransaction: number };
  conflicts: Array<{ field: 'api' | 'dbSession' | 'dbTransaction'; port: number; reason: 'manager' | 'docker' }>;
  dockerAvailable: boolean;
};

type WizardValues = {
  name: string;
  release: string;
  customRelease: string;
  publicUrl: string;
  siteUrl: string;
  apiPort: string;
  databaseSessionPort: string;
  databaseTransactionPort: string;
  dashboardUsername: string;
  credentialsMode: 'generated' | 'custom';
  postgresPassword: string;
  dashboardPassword: string;
  jwtSecret: string;
};

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function directUrl(hostname: string, port: string, protocol = 'http:'): string {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return host ? `${protocol}//${host}:${port}` : '';
}

function generatedSecret(prefix: string, byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${prefix}1_${encoded}`;
}

function Wizard({ organization, step, setStep, onCancel }: { organization: OrganizationSummary; step: WizardStep; setStep: (step: WizardStep) => void; onCancel: () => void }) {
  const [state, formAction, pending] = useActionState(createProjectAction, {});
  const [options, setOptions] = useState<WizardOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [address, setAddress] = useState('');
  const [urlLinkedToPort, setUrlLinkedToPort] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [values, setValues] = useState<WizardValues>({
    name: '', release: '', customRelease: '', publicUrl: '', siteUrl: '', apiPort: '8100',
    databaseSessionPort: '54100', databaseTransactionPort: '55100', dashboardUsername: 'admin',
    credentialsMode: 'generated', postgresPassword: '', dashboardPassword: '', jwtSecret: '',
  });
  const set = <K extends keyof WizardValues>(key: K, value: WizardValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    let active = true;
    void fetch('/api/wizard/options', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Project defaults could not be loaded');
      return response.json() as Promise<WizardOptions>;
    }).then((loaded) => {
      if (!active) return;
      setOptions(loaded);
      const configured = (() => { try { return new URL(loaded.managerPublicUrl); } catch { return null; } })();
      const browserHost = isLoopback(window.location.hostname) ? '' : window.location.hostname;
      const configuredHost = configured && !isLoopback(configured.hostname) ? configured.hostname : '';
      const selectedHost = configuredHost || browserHost;
      const protocol = configuredHost ? configured?.protocol : window.location.protocol === 'https:' ? 'https:' : 'http:';
      const apiPort = String(loaded.suggested.api);
      const projectUrl = directUrl(selectedHost, apiPort, protocol || 'http:');
      setAddress(selectedHost);
      setValues((current) => ({
        ...current,
        release: loaded.latestRelease,
        apiPort,
        databaseSessionPort: String(loaded.suggested.dbSession),
        databaseTransactionPort: String(loaded.suggested.dbTransaction),
        publicUrl: projectUrl,
        siteUrl: projectUrl,
      }));
    }).catch((error) => {
      if (active) setFieldErrors({ options: error instanceof Error ? error.message : 'Project defaults could not be loaded' });
    }).finally(() => { if (active) setLoadingOptions(false); });
    return () => { active = false; };
  }, []);

  const addressChoices = (() => {
    const choices = new Set<string>();
    try {
      const configuredHost = options ? new URL(options.managerPublicUrl).hostname : '';
      if (configuredHost && !isLoopback(configuredHost)) choices.add(configuredHost);
    } catch { /* Invalid configuration is reported by the server configuration parser. */ }
    if (typeof window !== 'undefined' && !isLoopback(window.location.hostname)) choices.add(window.location.hostname);
    if (address) choices.add(address);
    return [...choices];
  })();

  const updateDirectUrl = (nextAddress: string, nextPort = values.apiPort) => {
    setAddress(nextAddress);
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https:' : 'http:';
    const nextUrl = directUrl(nextAddress, nextPort, protocol);
    setValues((current) => ({ ...current, publicUrl: nextUrl, siteUrl: current.siteUrl === current.publicUrl || !current.siteUrl ? nextUrl : current.siteUrl }));
    setUrlLinkedToPort(true);
  };

  const refreshSuggestedPorts = async () => {
    setLoadingOptions(true);
    setFieldErrors({});
    try {
      const response = await fetch('/api/wizard/options', { cache: 'no-store' });
      if (!response.ok) throw new Error('Available ports could not be refreshed');
      const loaded = await response.json() as WizardOptions;
      setOptions(loaded);
      const apiPort = String(loaded.suggested.api);
      setValues((current) => ({
        ...current,
        apiPort,
        databaseSessionPort: String(loaded.suggested.dbSession),
        databaseTransactionPort: String(loaded.suggested.dbTransaction),
        ...(() => {
          if (!urlLinkedToPort) return { publicUrl: current.publicUrl, siteUrl: current.siteUrl };
          const nextUrl = directUrl(address, apiPort, window.location.protocol === 'https:' ? 'https:' : 'http:');
          return { publicUrl: nextUrl, siteUrl: current.siteUrl === current.publicUrl ? nextUrl : current.siteUrl };
        })(),
      }));
    } catch (error) {
      setFieldErrors({ ports: error instanceof Error ? error.message : 'Available ports could not be refreshed' });
    } finally { setLoadingOptions(false); }
  };

  const continueFromDetails = () => {
    const errors: Record<string, string> = {};
    if (values.name.trim().length < 2) errors.name = 'Enter a project name with at least 2 characters.';
    const release = values.release === 'custom' ? values.customRelease : values.release;
    if (!/^self-hosted\/v\d+\.\d+\.\d+$/.test(release)) errors.release = 'Use an official tag such as self-hosted/v0.8.0.';
    for (const [key, value] of [['publicUrl', values.publicUrl], ['siteUrl', values.siteUrl]] as const) {
      try { new URL(value); } catch { errors[key] = 'Enter a complete URL including http:// or https://.'; }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length === 0) setStep(2);
  };

  const continueFromPorts = async () => {
    const portValues = {
      api: Number(values.apiPort), dbSession: Number(values.databaseSessionPort), dbTransaction: Number(values.databaseTransactionPort),
    };
    const errors: Record<string, string> = {};
    for (const [key, port] of Object.entries(portValues)) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors[key] = 'Use a port between 1 and 65535.';
    }
    if (new Set(Object.values(portValues)).size !== 3) errors.ports = 'Each project endpoint needs a different host port.';
    if (Object.keys(errors).length > 0) { setFieldErrors(errors); return; }
    setLoadingOptions(true);
    try {
      const query = new URLSearchParams(Object.entries(portValues).map(([key, value]) => [key, String(value)]));
      const response = await fetch(`/api/wizard/options?${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Port availability could not be checked');
      const loaded = await response.json() as WizardOptions;
      setOptions(loaded);
      for (const conflict of loaded.conflicts) errors[conflict.field] = `Port ${conflict.port} is already used by ${conflict.reason === 'docker' ? 'a Docker container' : 'another managed project'}.`;
      if (!loaded.dockerAvailable) errors.ports = 'Docker port discovery is unavailable. Check the manager socket connection.';
      setFieldErrors(errors);
      if (Object.keys(errors).length === 0) setStep(3);
    } catch (error) {
      setFieldErrors({ ports: error instanceof Error ? error.message : 'Port availability could not be checked' });
    } finally { setLoadingOptions(false); }
  };

  const customizeSecrets = () => setValues((current) => ({
    ...current,
    credentialsMode: 'custom',
    postgresPassword: current.postgresPassword || generatedSecret('Pg', 24),
    dashboardPassword: current.dashboardPassword || generatedSecret('Studio', 24),
    jwtSecret: current.jwtSecret || generatedSecret('Jwt', 48),
  }));
  const selectedRelease = values.release === 'custom' ? values.customRelease : values.release;
  const hiddenValues = { ...values, supabaseRelease: selectedRelease };

  return <div className="wizard-shell">
    <div className="page-heading"><div><div className="eyebrow">New project</div><h1>Create a new project</h1><p>Your project will run as an isolated official Supabase deployment.</p></div></div>
    <div className="wizard-progress">{[['1', 'Project details'], ['2', 'Ports & access'], ['3', 'Secrets']] .map(([number, label], index) => <div key={number} className={`step ${step > index + 1 ? 'done' : ''} ${step === index + 1 ? 'active' : ''}`}><span className="step-number">{step > index + 1 ? '✓' : number}</span><span>{label}</span>{index < 2 && <span className="step-line" />}</div>)}</div>
    <section className="wizard-panel">
      {step === 1 && <><h2>Project details</h2><p>Choose the release and the addresses Supabase will advertise to clients.</p><div className="form-grid">
        <div className={`field ${fieldErrors.name ? 'invalid' : ''}`}><label>Project name</label><input value={values.name} onChange={(event) => set('name', event.target.value)} placeholder="Customer portal" autoFocus />{fieldErrors.name && <small className="field-error">{fieldErrors.name}</small>}</div>
        <div className={`field ${fieldErrors.release ? 'invalid' : ''}`}><label>Official stack release</label><select value={values.release} onChange={(event) => set('release', event.target.value)} disabled={loadingOptions}>{!options && <option value="">Loading releases…</option>}{options?.releases.map((release, index) => <option value={release} key={release}>{release}{index === 0 ? ' — Latest' : ''}</option>)}<option value="custom">Custom official tag…</option></select>{values.release === 'custom' && <input className="mono nested-input" value={values.customRelease} onChange={(event) => set('customRelease', event.target.value)} placeholder="self-hosted/v0.8.0" />}{fieldErrors.release && <small className="field-error">{fieldErrors.release}</small>}</div>
        <div className="field full"><label>Server address</label><div className="address-row"><select value={address} onChange={(event) => updateDirectUrl(event.target.value)}><option value="">Enter manually</option>{addressChoices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select><input value={address} onChange={(event) => updateDirectUrl(event.target.value.trim())} placeholder="192.168.1.20 or supabase.example.com" /></div><small>The manager URL and the address used by this browser are offered here. Agent addresses will join this list when remote hosts are introduced.</small></div>
        <div className={`field full ${fieldErrors.publicUrl ? 'invalid' : ''}`}><label>Public project URL</label><input className="mono" value={values.publicUrl} onChange={(event) => { set('publicUrl', event.target.value); setUrlLinkedToPort(false); }} placeholder="http://192.168.1.20:8100" /><small>{urlLinkedToPort ? 'Linked to the API gateway host port.' : 'Custom or reverse-proxied URL. The gateway host port remains independent.'}</small>{fieldErrors.publicUrl && <small className="field-error">{fieldErrors.publicUrl}</small>}</div>
        <div className={`field full ${fieldErrors.siteUrl ? 'invalid' : ''}`}><label>Auth site URL</label><input className="mono" value={values.siteUrl} onChange={(event) => set('siteUrl', event.target.value)} placeholder="https://app.example.com" /><small>This is your application’s default Auth redirect URL—not the manager URL. The project URL is used initially so port 3000 is never assumed.</small>{fieldErrors.siteUrl && <small className="field-error">{fieldErrors.siteUrl}</small>}</div>
      </div>{fieldErrors.options && <div className="form-error" role="alert">{fieldErrors.options}</div>}</>}
      {step === 2 && <><div className="panel-title-row"><div><h2>Ports & access</h2><p>Suggested ports are calculated from manager reservations and live Docker bindings.</p></div><button type="button" className="btn btn-secondary" onClick={() => void refreshSuggestedPorts()} disabled={loadingOptions}>{loadingOptions ? 'Checking…' : 'Refresh suggestions'}</button></div><div className="form-grid">
        <div className={`field ${fieldErrors.api ? 'invalid' : ''}`}><label>API / {selectedRelease.startsWith('self-hosted/v0.7.') ? 'Kong' : 'Envoy'} port</label><input className="mono" inputMode="numeric" value={values.apiPort} onChange={(event) => { const port = event.target.value; setValues((current) => { if (!urlLinkedToPort) return { ...current, apiPort: port }; const nextUrl = directUrl(address, port, window.location.protocol === 'https:' ? 'https:' : 'http:'); return { ...current, apiPort: port, publicUrl: nextUrl, siteUrl: current.siteUrl === current.publicUrl ? nextUrl : current.siteUrl }; }); }} />{fieldErrors.api && <small className="field-error">{fieldErrors.api}</small>}</div>
        <div className={`field ${fieldErrors.dbSession ? 'invalid' : ''}`}><label>Database session pooler</label><input className="mono" inputMode="numeric" value={values.databaseSessionPort} onChange={(event) => set('databaseSessionPort', event.target.value)} />{fieldErrors.dbSession && <small className="field-error">{fieldErrors.dbSession}</small>}</div>
        <div className={`field ${fieldErrors.dbTransaction ? 'invalid' : ''}`}><label>Database transaction pooler</label><input className="mono" inputMode="numeric" value={values.databaseTransactionPort} onChange={(event) => set('databaseTransactionPort', event.target.value)} />{fieldErrors.dbTransaction && <small className="field-error">{fieldErrors.dbTransaction}</small>}</div>
        <div className="field"><label>Bind address</label><select value="0.0.0.0" disabled><option>0.0.0.0 — all interfaces</option></select></div>
      </div><div className="endpoint-preview"><span>Public URL</span><code>{values.publicUrl || 'Enter a server address on the previous step'}</code>{!urlLinkedToPort && <button type="button" className="btn-link" onClick={() => updateDirectUrl(address)}>Link to gateway port</button>}</div>{fieldErrors.ports && <div className="form-error" role="alert">{fieldErrors.ports}</div>}<div className="warning">Ports are only reserved when you deploy. Opening or canceling this wizard does not consume them.</div></>}
      {step === 3 && <form action={formAction}><input type="hidden" name="organizationId" value={organization.id} />{Object.entries(hiddenValues).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}<h2>Secrets & dashboard access</h2><p>Review how credentials will be created before deployment begins.</p><label className={`secret-option ${values.credentialsMode === 'generated' ? 'selected' : ''}`}><input type="radio" checked={values.credentialsMode === 'generated'} onChange={() => set('credentialsMode', 'generated')} /><div><strong>Generate secure secrets</strong><span>Recommended. The official release helpers generate a mutually compatible credential bundle.</span></div></label><label className={`secret-option ${values.credentialsMode === 'custom' ? 'selected' : ''}`}><input type="radio" checked={values.credentialsMode === 'custom'} onChange={customizeSecrets} /><div><strong>Customize secrets</strong><span>Secure generated values are pre-filled; change only the values you need.</span></div></label><div className="form-grid secrets-grid"><div className="field"><label>Studio username</label><input value={values.dashboardUsername} onChange={(event) => set('dashboardUsername', event.target.value)} /></div>{values.credentialsMode === 'custom' && <><div className="field"><label>Studio password</label><input type="text" className="mono" value={values.dashboardPassword} onChange={(event) => set('dashboardPassword', event.target.value)} /></div><div className="field"><label>PostgreSQL password</label><input type="text" className="mono" value={values.postgresPassword} onChange={(event) => set('postgresPassword', event.target.value)} /></div><div className="field"><label>JWT secret</label><input type="text" className="mono" value={values.jwtSecret} onChange={(event) => set('jwtSecret', event.target.value)} /></div></>}</div><div className="security-note">Credentials remain encrypted at rest and can be revealed or copied later by organization administrators.</div>{state.error && <div className="form-error form-error-spaced" role="alert">{state.error}</div>}<div className="wizard-footer"><button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>Back</button><button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Queueing…' : 'Deploy project'}</button></div></form>}
      {step < 3 && <div className="wizard-footer"><button type="button" className="btn btn-secondary" onClick={() => step === 1 ? onCancel() : setStep(1)}>{step === 1 ? 'Cancel' : 'Back'}</button><button type="button" className="btn btn-primary" onClick={() => step === 1 ? continueFromDetails() : void continueFromPorts()} disabled={loadingOptions}>{loadingOptions ? 'Checking…' : 'Continue'}</button></div>}
    </section>
  </div>;
}

function Deployment({ job, onCredentials }: { job?: ActiveJobSummary; onCredentials: () => void }) {
  const router = useRouter();
  useEffect(() => {
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
    const timer = window.setInterval(() => router.refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [job, router]);
  const currentStage = job?.stage?.replaceAll('-', ' ').replaceAll('_', ' ') ?? 'queued';
  const statusClass = job?.status === 'failed' ? 'red' : job?.status === 'succeeded' ? '' : 'amber';
  return <><div className="page-heading"><div><div className="eyebrow">Project deployment</div><h1>Provisioning job</h1><p>The durable broker job survives page reloads and manager restarts.</p></div><span className={`status ${statusClass}`}><span className="status-dot" /> {job?.status ?? 'queued'}</span></div><div className="deployment-layout"><section className="deployment-card"><h2>Deployment progress</h2><p>Current stage: {currentStage}</p><div className="progress-track"><span style={{ width: job?.status === 'succeeded' ? '100%' : job?.status === 'queued' ? '5%' : '55%' }} /></div>{stages.map(([mark, title, detail]) => <div className={`stage ${title.toLowerCase().includes(currentStage.split(' ')[0] ?? '') ? 'current' : mark === '○' ? 'pending' : ''}`} key={title}><span className="stage-mark">{mark}</span><div><strong>{title}</strong><small>{detail}</small></div></div>)}</section><aside className="deployment-card"><h2>Live diagnostics</h2><p>Sanitized events emitted by the broker.</p>{job?.events.length ? job.events.slice(-5).map((event) => <div className="diagnostic-item" key={event.sequence}><span className="diag-icon">{event.level === 'error' ? '!' : '✓'}</span><div><strong>{event.stage?.replaceAll('-', ' ') ?? 'job'}</strong><span>{event.message}</span></div></div>) : <div className="diagnostic-item"><span className="diag-icon">◌</span><div><strong>Queued</strong><span>Waiting for the provisioning worker.</span></div></div>}</aside></div><section className="deployment-card" style={{ marginTop: 18 }}><h2>Provisioning output</h2><p>Secrets are redacted before events are persisted.</p><div className="log-box mono">{job?.events.length ? job.events.map((event) => <div key={event.sequence}>[{new Date(event.createdAt).toLocaleTimeString()}] {event.message}</div>) : 'No provisioning events yet.'}{job?.errorMessage && <div className="error-text">{job.errorMessage}</div>}</div><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 17 }}><button className="btn btn-primary" disabled={job?.status !== 'succeeded'} onClick={onCredentials}>View credentials</button></div></section></>;
}

function Credentials({ project }: { project?: ProjectSummary }) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState('');
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const values: Record<string, string> = { url: project?.publicUrl ?? 'No project selected', ...loaded };
  const load = async (): Promise<Record<string, string> | undefined> => {
    if (!project) return undefined;
    if (loaded.publishable) return loaded;
    const result = await revealProjectCredentialsAction(project.id);
    if (!result.credentials) { setError(result.error ?? 'Credentials are unavailable.'); return undefined; }
    const next: Record<string, string> = { ...result.credentials, db: result.credentials.database };
    setLoaded(next);
    setError('');
    return next;
  };
  const reveal = async (key: string) => {
    if (key !== 'url' && !revealed[key] && !(await load())) return;
    setRevealed((current) => ({ ...current, [key]: !current[key] }));
  };
  const copy = async (key: string) => {
    const available = key === 'url' ? values : await load();
    const value = key === 'url' ? values.url : available?.[key];
    if (!value) return;
    try { await navigator.clipboard.writeText(value); } catch { setError('Clipboard access is unavailable in this browser.'); return; }
    setCopied(key); setTimeout(() => setCopied(''), 1500);
  };
  return <><div className="page-heading"><div><div className="eyebrow">{project?.name ?? 'Project'}</div><h1>Credentials</h1><p>Connection details and API keys for this project.</p></div><span className={`status ${project?.status === 'failed' ? 'red' : project?.status !== 'ready' ? 'amber' : ''}`}><span className="status-dot" /> {project?.status ?? 'Unavailable'}</span></div><div className="notice"><span className="notice-icon">⌁</span><div><strong>Keep secret keys private</strong>Only share publishable keys with browser and mobile clients. Secret keys and database credentials should stay on trusted servers.</div></div>{error && <div className="form-error" role="alert">{error}</div>}<div className="credentials-grid"><section className="section-card"><div className="section-card-header"><div><h2>Project credentials</h2><p>Reveal or copy values when you need to connect an application.</p></div></div><div className="section-card-body">{([['url', 'Project URL'], ['publishable', 'Publishable key'], ['secret', 'Secret key'], ['db', 'Database connection'], ['jwt', 'JWT secret'], ['dashboard', 'Studio login']] as const).map(([key, label]) => <div className="credential-row" key={key}><span className="credential-label">{label}</span><span className={`credential-value mono ${!revealed[key] && key !== 'url' ? 'masked' : ''}`}>{revealed[key] || key === 'url' ? (values[key] ?? 'Load credentials to reveal') : '••••••••••••••••••••'}</span><div className="credential-actions"><button onClick={() => reveal(key)}>{revealed[key] ? 'Hide' : 'Reveal'}</button><button onClick={() => copy(key)}>{copied === key ? 'Copied' : 'Copy'}</button></div></div>)}</div></section><div><section className="endpoint-card"><h3>Connection endpoints</h3><div className="endpoint"><span>REST / GraphQL</span><code>{project?.publicUrl ?? 'Unavailable'}</code></div><div className="endpoint"><span>Session pooler</span><code>{project ? `server:${project.databaseSessionPort}` : 'Unavailable'}</code></div><div className="endpoint"><span>Transaction pooler</span><code>{project ? `server:${project.databaseTransactionPort}` : 'Unavailable'}</code></div><div className="endpoint"><span>Realtime</span><code>{project?.publicUrl.replace(/^http/, 'ws') ?? 'Unavailable'}</code></div></section><div className="security-note" style={{ marginTop: 16 }}><strong>Protected action</strong><br />Values are decrypted only after the server verifies your active manager session and organization access.</div></div></div></>;
}

export default function ManagerShell({ initialScreen, user, organizations, projects, activeJob }: ManagerShellProps) {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? '');
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? '');
  const [orgMenu, setOrgMenu] = useState(false);
  if (screen === 'setup' || screen === 'login' || !user) return <AuthScreen mode={initialScreen === 'login' ? 'login' : 'setup'} />;
  if (organizations.length === 0) return <main className="auth-screen"><div className="auth-card"><Brand /><div className="eyebrow">First organization</div><h1>Create your workspace</h1><p>Projects and access permissions are grouped inside organizations.</p><form action={createOrganizationAction}><div className="field"><label>Organization name</label><input name="name" placeholder="Acme Labs" required /></div><button className="btn btn-primary btn-wide">Create organization</button></form><form action={logoutAction}><button className="btn btn-link btn-wide" style={{ marginTop: 18 }}>Sign out</button></form></div></main>;
  const organization = organizations.find((item) => item.id === organizationId) ?? organizations[0]!;
  const organizationProjects = projects.filter((project) => project.organizationId === organization.id);
  const title = screen === 'deployment' ? 'Deployment' : screen === 'credentials' ? 'Credentials' : screen === 'import' ? 'Import project' : 'Projects';
  const selectedProject = organizationProjects.find((project) => project.id === selectedProjectId) ?? organizationProjects[0];
  return <div className="app-shell"><Sidebar screen={screen} setScreen={setScreen} organization={organization} user={user} onOrgMenu={() => setOrgMenu(!orgMenu)} />{orgMenu && <div className="switcher-menu">{organizations.map((org) => <button className={org.id === organization.id ? 'active' : ''} key={org.id} onClick={() => { setOrganizationId(org.id); setSelectedProjectId(projects.find((project) => project.organizationId === org.id)?.id ?? ''); setOrgMenu(false); setScreen('dashboard'); }}>{org.id === organization.id ? '✓ ' : ''}{org.name}</button>)}<form action={createOrganizationAction}><input name="name" placeholder="New organization" required /><button>＋ Create organization</button></form></div>}<main className="main"><Topbar title={title} organization={organization} user={user} onHelp={() => window.alert('Need help? Check the deployment diagnostics or project documentation.')} /><div className="content">{screen === 'dashboard' && <Dashboard organization={organization} projects={organizationProjects} onCreate={() => { setWizardStep(1); setScreen('wizard'); }} onImport={() => setScreen('import')} onSelect={(projectId) => { setSelectedProjectId(projectId); setScreen('credentials'); }} />}{screen === 'wizard' && <Wizard organization={organization} step={wizardStep} setStep={setWizardStep} onCancel={() => setScreen('dashboard')} />}{screen === 'import' && <ImportProject organization={organization} onCancel={() => setScreen('dashboard')} />}{screen === 'deployment' && <Deployment job={activeJob} onCredentials={() => { if (activeJob?.projectId) setSelectedProjectId(activeJob.projectId); setScreen('credentials'); }} />}{screen === 'credentials' && <Credentials project={selectedProject} />}</div></main></div>;
}
