'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createOrganizationAction,
  createProjectAction,
  loginAction,
  logoutAction,
  revealProjectCredentialsAction,
  setupAdminAction,
} from '@/app/actions';

type Screen = 'dashboard' | 'wizard' | 'deployment' | 'credentials' | 'setup' | 'login';
type WizardStep = 1 | 2 | 3;

export type OrganizationSummary = { id: string; name: string; initials: string; role: string };
export type ProjectSummary = {
  id: string;
  organizationId: string;
  name: string;
  status: string;
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

function AuthScreen({ mode, onSwitch }: { mode: 'setup' | 'login'; onSwitch: () => void }) {
  const setup = mode === 'setup';
  const [state, formAction, pending] = useActionState(setup ? setupAdminAction : loginAction, {});
  return (
    <main className="auth-screen">
      <form className="auth-card" action={formAction}>
        <Brand />
        <div className="eyebrow">{setup ? 'Welcome' : 'Secure workspace'}</div>
        <h1>{setup ? 'Set up your manager' : 'Welcome back'}</h1>
        <p>{setup ? 'Create the first administrator account. This account controls every organization and project on this server.' : 'Sign in to manage your self-hosted Supabase projects.'}</p>
        {setup && <div className="notice"><span className="notice-icon">✦</span><div><strong>Local-first by design</strong>This manager does not send your project data or credentials to a third party.</div></div>}
        {setup && <div className="field"><label>Full name</label><input name="displayName" autoComplete="name" placeholder="Alex Morgan" required /></div>}
        <div className="field"><label>Email address</label><input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></div>
        <div className="field"><label>Password</label><div className="input-wrap"><input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} placeholder="At least 12 characters" required /><button type="button" aria-label="Show password">◉</button></div>{setup && <small>Use a unique password. Two-factor authentication can be added later.</small>}</div>
        {setup && <div className="field"><label>Confirm password</label><input name="confirmPassword" type="password" autoComplete="new-password" placeholder="Repeat your password" required /></div>}
        {state.error && <div className="form-error" role="alert">{state.error}</div>}
        <button className="btn btn-primary btn-wide" disabled={pending}>{pending ? 'Please wait…' : setup ? 'Create administrator account' : 'Sign in'}</button>
        <p style={{ margin: '23px 0 0', textAlign: 'center', fontSize: 12 }}>{setup ? <>Already have an account? <button type="button" className="btn-link" onClick={onSwitch}>Sign in</button></> : <>First time here? <button type="button" className="btn-link" onClick={onSwitch}>Set up this manager</button></>}</p>
      </form>
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

function Dashboard({ organization, projects, onCreate, onCredentials, onSelect }: { organization: OrganizationSummary; projects: ProjectSummary[]; onCreate: () => void; onCredentials: () => void; onSelect: (projectId: string) => void }) {
  const running = projects.filter((project) => project.status === 'ready').length;
  return <>
    <div className="page-heading"><div><div className="eyebrow">Organization overview</div><h1>Projects</h1><p>Deployments belonging to {organization.name} are managed from this workspace.</p></div><div className="heading-actions"><button className="btn btn-secondary" onClick={onCredentials} disabled={projects.length === 0}>View credentials</button><button className="btn btn-primary" onClick={onCreate}>＋ New project</button></div></div>
    {projects.length === 0 && <div className="notice"><span className="notice-icon">✦</span><div><strong>Your organization is ready</strong>Create your first project to provision an isolated Supabase stack with named volumes and generated credentials.</div></div>}
    <div className="stat-grid"><div className="stat-card"><div className="stat-label">Projects</div><div className="stat-value">{projects.length}</div></div><div className="stat-card"><div className="stat-label">Ready projects</div><div className="stat-value">{running}</div></div><div className="stat-card"><div className="stat-label">Organization role</div><div className="stat-value" style={{ fontSize: 17 }}>{organization.role}</div></div></div>
    <section className="section-card"><div className="section-card-header"><div><h2>Projects</h2><p>Each project runs in its own network and named volumes.</p></div><span className="tiny">{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span></div>{projects.length === 0 ? <div className="empty-state"><div className="empty-graphic">⌁</div><h2>No projects yet</h2><p>Projects are full Supabase deployments with their own database, Auth, Storage, Realtime, and Studio services.</p><button className="btn btn-primary" onClick={onCreate}>Create your first project</button></div> : <div className="section-card-body"><table className="project-table"><thead><tr><th>Project</th><th>Status</th><th>API endpoint</th><th>Release</th></tr></thead><tbody>{projects.map((project) => <tr key={project.id} tabIndex={0} onClick={() => onSelect(project.id)} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(project.id); }}><td><div className="project-cell"><span className="project-icon">⌁</span><div><strong>{project.name}</strong><span>{project.id.slice(0, 8)}</span></div></div></td><td><span className={`status ${project.status === 'failed' ? 'red' : project.status !== 'ready' ? 'amber' : ''}`}><span className="status-dot" />{project.status}</span></td><td className="mono">{project.publicUrl}</td><td>{project.release}</td></tr>)}</tbody></table></div>}</section>
  </>;
}

function Wizard({ organization, step, setStep, onCancel }: { organization: OrganizationSummary; step: WizardStep; setStep: (step: WizardStep) => void; onCancel: () => void }) {
  const [state, formAction, pending] = useActionState(createProjectAction, {});
  const [values, setValues] = useState({
    name: '',
    publicUrl: 'http://localhost:8100',
    siteUrl: 'http://localhost:3000',
    apiPort: '8100',
    databaseSessionPort: '54100',
    databaseTransactionPort: '55100',
    dashboardUsername: 'admin',
    credentialsMode: 'generated' as 'generated' | 'custom',
    postgresPassword: '',
    dashboardPassword: '',
    jwtSecret: '',
  });
  const set = (key: keyof typeof values, value: string) => setValues((current) => ({ ...current, [key]: value }));
  return <form className="wizard-shell" action={formAction}>
    <input type="hidden" name="organizationId" value={organization.id} />
    <input type="hidden" name="supabaseRelease" value="self-hosted/v0.8.0" />
    {Object.entries(values).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
    <div className="page-heading"><div><div className="eyebrow">New project</div><h1>Create a project</h1><p>Configure your isolated Supabase deployment on this server.</p></div></div>
    <div className="wizard-progress">{[['1', 'Project details'], ['2', 'Ports & access'], ['3', 'Secrets']] .map(([number, label], index) => <div key={number} className={`step ${step > index + 1 ? 'done' : ''} ${step === index + 1 ? 'active' : ''}`}><span className="step-number">{step > index + 1 ? '✓' : number}</span><span>{label}</span>{index < 2 && <span className="step-line" />}</div>)}</div>
    <section className="wizard-panel">
      {step === 1 && <><h2>Project details</h2><p>Give your deployment a recognizable name. It can be changed later without affecting the runtime.</p><div className="form-grid"><div className="field"><label>Project name</label><input value={values.name} onChange={(event) => set('name', event.target.value)} placeholder="e.g. Customer portal" required /></div><div className="field"><label>Official stack release</label><input value="self-hosted/v0.8.0" readOnly /><small>The first supported Envoy/Postgres 17 release adapter.</small></div><div className="field full"><label>Public project URL</label><input value={values.publicUrl} onChange={(event) => set('publicUrl', event.target.value)} placeholder="http://192.168.1.20:8100" required /><small>Use a local IP now or the final FQDN if one is already available.</small></div><div className="field full"><label>Default Auth site URL</label><input value={values.siteUrl} onChange={(event) => set('siteUrl', event.target.value)} placeholder="https://app.example.com" required /></div></div></>}
      {step === 2 && <><h2>Ports & access</h2><p>Choose the host-facing ports for this project. Internal Supabase ports stay unchanged.</p><div className="form-grid"><div className="field"><label>API / Envoy port</label><input className="mono" inputMode="numeric" value={values.apiPort} onChange={(event) => set('apiPort', event.target.value)} /></div><div className="field"><label>Database session pooler</label><input className="mono" inputMode="numeric" value={values.databaseSessionPort} onChange={(event) => set('databaseSessionPort', event.target.value)} /></div><div className="field"><label>Database transaction pooler</label><input className="mono" inputMode="numeric" value={values.databaseTransactionPort} onChange={(event) => set('databaseTransactionPort', event.target.value)} /></div><div className="field"><label>Bind address</label><select defaultValue="0.0.0.0" disabled><option>0.0.0.0 — all interfaces</option></select></div></div><div className="warning">The manager reserves all three ports transactionally before provisioning begins.</div></>}
      {step === 3 && <><h2>Secrets & dashboard access</h2><p>Credentials are encrypted at rest and remain retrievable from the project Credentials page.</p><label className={`secret-option ${values.credentialsMode === 'generated' ? 'selected' : ''}`}><input type="radio" checked={values.credentialsMode === 'generated'} onChange={() => set('credentialsMode', 'generated')} /><div><strong>Generate secure secrets</strong><span>Recommended. Version-aware Supabase helpers create compatible JWT keys and internal credentials.</span></div></label><label className={`secret-option ${values.credentialsMode === 'custom' ? 'selected' : ''}`}><input type="radio" checked={values.credentialsMode === 'custom'} onChange={() => set('credentialsMode', 'custom')} /><div><strong>Customize secrets</strong><span>Supply the database password, JWT secret, and dashboard password; dependent keys remain generated as a consistent bundle.</span></div></label><div className="form-grid" style={{ marginTop: 22 }}><div className="field"><label>Studio username</label><input value={values.dashboardUsername} onChange={(event) => set('dashboardUsername', event.target.value)} /></div>{values.credentialsMode === 'custom' && <><div className="field"><label>Studio password</label><input type="password" value={values.dashboardPassword} onChange={(event) => set('dashboardPassword', event.target.value)} /></div><div className="field"><label>PostgreSQL password</label><input type="password" value={values.postgresPassword} onChange={(event) => set('postgresPassword', event.target.value)} /></div><div className="field"><label>JWT secret</label><input type="password" value={values.jwtSecret} onChange={(event) => set('jwtSecret', event.target.value)} /></div></>}</div><div className="security-note">Credentials can be revealed and copied later by authorized organization administrators.</div></>}
      {state.error && <div className="form-error" role="alert">{state.error}</div>}
      <div className="wizard-footer"><button type="button" className="btn btn-secondary" onClick={() => step === 1 ? onCancel() : setStep((step - 1) as WizardStep)}>{step === 1 ? 'Cancel' : 'Back'}</button><div className="right">{step < 3 ? <button type="button" className="btn btn-primary" onClick={() => setStep((step + 1) as WizardStep)}>Continue</button> : <button className="btn btn-primary" disabled={pending}>{pending ? 'Queueing…' : 'Deploy project'}</button>}</div></div>
    </section>
  </form>;
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
  const [authMode, setAuthMode] = useState<'setup' | 'login'>(initialScreen === 'login' ? 'login' : 'setup');
  if (screen === 'setup' || screen === 'login' || !user) return <AuthScreen mode={authMode} onSwitch={() => setAuthMode(authMode === 'setup' ? 'login' : 'setup')} />;
  if (organizations.length === 0) return <main className="auth-screen"><div className="auth-card"><Brand /><div className="eyebrow">First organization</div><h1>Create your workspace</h1><p>Projects and access permissions are grouped inside organizations.</p><form action={createOrganizationAction}><div className="field"><label>Organization name</label><input name="name" placeholder="Acme Labs" required /></div><button className="btn btn-primary btn-wide">Create organization</button></form><form action={logoutAction}><button className="btn btn-link btn-wide" style={{ marginTop: 18 }}>Sign out</button></form></div></main>;
  const organization = organizations.find((item) => item.id === organizationId) ?? organizations[0]!;
  const organizationProjects = projects.filter((project) => project.organizationId === organization.id);
  const title = screen === 'wizard' ? 'Create project' : screen === 'deployment' ? 'Deployment' : screen === 'credentials' ? 'Credentials' : 'Projects';
  const selectedProject = organizationProjects.find((project) => project.id === selectedProjectId) ?? organizationProjects[0];
  return <div className="app-shell"><Sidebar screen={screen} setScreen={setScreen} organization={organization} user={user} onOrgMenu={() => setOrgMenu(!orgMenu)} />{orgMenu && <div className="switcher-menu">{organizations.map((org) => <button className={org.id === organization.id ? 'active' : ''} key={org.id} onClick={() => { setOrganizationId(org.id); setSelectedProjectId(projects.find((project) => project.organizationId === org.id)?.id ?? ''); setOrgMenu(false); setScreen('dashboard'); }}>{org.id === organization.id ? '✓ ' : ''}{org.name}</button>)}<form action={createOrganizationAction}><input name="name" placeholder="New organization" required /><button>＋ Create organization</button></form></div>}<main className="main"><Topbar title={title} organization={organization} user={user} onHelp={() => window.alert('Need help? Check the deployment diagnostics or project documentation.')} /><div className="content">{screen === 'dashboard' && <Dashboard organization={organization} projects={organizationProjects} onCreate={() => { setWizardStep(1); setScreen('wizard'); }} onCredentials={() => setScreen('credentials')} onSelect={(projectId) => { setSelectedProjectId(projectId); setScreen('credentials'); }} />}{screen === 'wizard' && <Wizard organization={organization} step={wizardStep} setStep={setWizardStep} onCancel={() => setScreen('dashboard')} />}{screen === 'deployment' && <Deployment job={activeJob} onCredentials={() => { if (activeJob?.projectId) setSelectedProjectId(activeJob.projectId); setScreen('credentials'); }} />}{screen === 'credentials' && <Credentials project={selectedProject} />}</div></main></div>;
}
