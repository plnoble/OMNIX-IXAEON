import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type AppState, type Project } from './api.js';
import { SetupWizard } from './pages/Setup.js';
import { ProjectsPage } from './pages/Projects.js';
import { SourcesPage } from './pages/Sources.js';
import { SearchPage } from './pages/Search.js';
import { SettingsPage } from './pages/Settings.js';
import { UnderstandingPage } from './pages/Understanding.js';
import { InboxPage, HistoryPage } from './pages/Inbox.js';
import { AskPage } from './pages/Ask.js';
import { PersonalOverviewPage } from './pages/Overview.js';
import { ResearchPage } from './pages/Research.js';
import { TasksPage } from './pages/Tasks.js';
import { ErrorBanner } from './ui.js';

type Page =
  | 'overview'
  | 'understanding'
  | 'inbox'
  | 'ask'
  | 'history'
  | 'projects'
  | 'sources'
  | 'search'
  | 'research'
  | 'tasks'
  | 'settings';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getState();
      setState(s);
      if (s.setupComplete) {
        setProjects(await api.listProjects());
      }
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  const reloadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!state?.setupComplete) return;
    if (
      page === 'projects' ||
      page === 'sources' ||
      page === 'search' ||
      page === 'ask' ||
      page === 'inbox' ||
      page === 'understanding' ||
      page === 'tasks'
    ) {
      void reloadProjects();
    }
  }, [page, state?.setupComplete, reloadProjects]);

  useEffect(() => {
    if (projectId && !projects.some((p) => p.id === projectId)) setProjectId(null);
  }, [projects, projectId]);

  if (error && state === null) {
    return <ErrorBanner message={error} />;
  }
  if (state === null) {
    return (
      <div className="app" data-testid="app-root">
        <p className="empty">加载中…</p>
      </div>
    );
  }

  if (!state.setupComplete) {
    return (
      <div className="app" data-testid="app-root">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        <SetupWizard
          state={state}
          onDone={(restartRequired) => {
            if (restartRequired) return; // 向导内已展示重启提示
            void refresh();
            setPage('sources');
          }}
        />
      </div>
    );
  }

  return (
    <div className="app" data-testid="app-root">
      <header className="app-header">
        <h1>
          IXAEON <span className="cn">析衍</span>
        </h1>
        <p className="tagline">本地个人内核：理解你、统筹项目、在授权边界内行动 · OMNIX</p>
        <nav className="nav" data-testid="main-nav">
          <button
            type="button"
            className={page === 'overview' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('overview')}
            data-testid="nav-overview"
          >
            总览
          </button>
          <button
            type="button"
            className={page === 'understanding' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('understanding')}
            data-testid="nav-understanding"
          >
            理解
          </button>
          <button
            type="button"
            className={page === 'inbox' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('inbox')}
            data-testid="nav-inbox"
          >
            待讨论
          </button>
          <button
            type="button"
            className={page === 'ask' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('ask')}
            data-testid="nav-ask"
          >
            问答
          </button>
          <button
            type="button"
            className={page === 'history' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('history')}
            data-testid="nav-history"
          >
            历史
          </button>
          <button
            type="button"
            className={page === 'projects' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('projects')}
            data-testid="nav-projects"
          >
            项目
          </button>
          <button
            type="button"
            className={page === 'sources' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('sources')}
            data-testid="nav-sources"
          >
            来源
          </button>
          <button
            type="button"
            className={page === 'search' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('search')}
            data-testid="nav-search"
          >
            检索
          </button>
          <button
            type="button"
            className={page === 'research' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('research')}
            data-testid="nav-research"
          >
            研究
          </button>
          <button
            type="button"
            className={page === 'tasks' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('tasks')}
            data-testid="nav-tasks"
          >
            任务
          </button>
          <button
            type="button"
            className={page === 'settings' ? 'nav-item active' : 'nav-item'}
            onClick={() => setPage('settings')}
            data-testid="nav-settings"
          >
            设置
          </button>
        </nav>
      </header>

      <main className="app-main">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {page === 'overview' && <PersonalOverviewPage state={state} />}

        {page === 'projects' && (
          <ProjectsPage
            onChanged={() => void reloadProjects()}
            onOpenSources={(id) => {
              setProjectId(id);
              setPage('sources');
            }}
          />
        )}

        {page === 'understanding' && <UnderstandingPage projects={projects} />}

        {page === 'inbox' && <InboxPage projects={projects} />}

        {page === 'ask' && <AskPage projects={projects} />}

        {page === 'history' && <HistoryPage />}

        {page === 'sources' && (
          <SourcesPage projects={projects} projectId={projectId} onProjectChange={setProjectId} />
        )}

        {page === 'search' && (
          <SearchPage projects={projects} projectId={projectId} onProjectChange={setProjectId} />
        )}

        {page === 'research' && <ResearchPage />}

        {page === 'tasks' && <TasksPage projects={projects} />}

        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
