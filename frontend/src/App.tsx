import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Gnb, type GnbTab } from './components/Gnb';
import { useSession, type Role } from './lib/session';
import { Login } from './pages/x/Login';
import { AdminLogin, Invite, NoAccess, Onboard } from './pages/x/Others';
import { Inbox } from './pages/a/Inbox';
import { CaseDetail } from './pages/a/CaseDetail';
import { History } from './pages/a/History';
import { Overview } from './pages/m/Overview';
import { TeamInbox } from './pages/m/TeamInbox';
import { AdminCase } from './pages/m/AdminCase';
import { Escalations } from './pages/m/Escalations';
import { OpsReport, VoiceReport } from './pages/m/Reports';
import { Manual } from './pages/m/Manual';
import { Hours, Team } from './pages/m/TeamHours';
import { After, Ask, Faq, MyTickets, Orders, Preparing, Shop } from './pages/c/Customer';

// 주소는 Figma "Page Rule"의 화면 ID를 그대로 쓴다 (개발 라우트 · QA 시트에도 같은 ID).
//   C = 고객 · A = 상담원 · M/S/R = 관리자 · X = 공통

const AGENT_TABS: GnbTab[] = [
  { to: '/A-100', label: '문의함', match: ['/A-100', '/A-101', '/A-110', '/A-200', '/A-210', '/A-220', '/A-230'] },

  { to: '/A-300', label: '내 처리 내역', match: ['/A-300', '/A-240'] },
];

const ADMIN_TABS: GnbTab[] = [
  { to: '/M-100', label: '운영 현황', match: ['/M-100', '/M-101'] },
  { to: '/M-110', label: '팀 문의함', match: ['/M-110', '/M-111'] },
  { to: '/M-200', label: '관리자 이관', match: ['/M-200', '/M-201', '/M-202', '/M-300', '/M-310', '/M-320'] },
  { to: '/R-100', label: '리포트', match: ['/R-'] },
  { to: '/S-110', label: '설정', match: ['/S-'] },
];

function Console({ role, tabs }: { role: Role; tabs: GnbTab[] }) {
  const { session } = useSession();
  const { pathname } = useLocation();
  if (!session) return <Navigate to="/X-100" replace />;
  // 역할이 맞지 않으면 권한 없음 화면으로: 관리자 화면 → X-900 · 상담원 화면 → X-910
  if (session.role !== role) return <Navigate to={role === 'admin' ? '/X-900' : '/X-910'} replace />;
  return (
    <>
      <Gnb tabs={tabs} pathname={pathname} />
      <Outlet />
    </>
  );
}

function InboxHome() {
  let view: string | null = null;
  try {
    view = localStorage.getItem('baton.inboxView');
  } catch {
    view = null;
  }
  return <Navigate to={view === 'kanban' ? '/A-110' : '/A-100'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/X-100" replace />} />
      <Route path="/X-100" element={<Login />} />
      <Route path="/X-110" element={<Invite />} />
      <Route path="/X-120" element={<AdminLogin />} />
      <Route path="/X-130" element={<Onboard />} />
      <Route path="/X-900" element={<NoAccess need="admin" />} />
      <Route path="/X-910" element={<NoAccess need="agent" />} />

      <Route element={<Console role="agent" tabs={AGENT_TABS} />}>
        <Route path="/A" element={<InboxHome />} />
        <Route path="/A-100" element={<Inbox view="list" />} />
        <Route path="/A-101" element={<Inbox view="list" tab="wait" />} />
        <Route path="/A-110" element={<Inbox view="kanban" />} />
        <Route path="/A-200/:id" element={<CaseDetail />} />
        <Route path="/A-210/:id" element={<CaseDetail />} />
        <Route path="/A-220/:id" element={<CaseDetail />} />
        <Route path="/A-230/:id" element={<CaseDetail />} />
        <Route path="/A-240/:id" element={<CaseDetail />} />
        <Route path="/A-300" element={<History />} />
      </Route>

      <Route element={<Console role="admin" tabs={ADMIN_TABS} />}>
        <Route path="/M-100" element={<Overview view="team" />} />
        <Route path="/M-101" element={<Overview view="agents" />} />
        <Route path="/M-110" element={<TeamInbox />} />
        <Route path="/M-111/:id" element={<AdminCase />} />
        <Route path="/M-200" element={<Escalations tab="waiting" />} />
        <Route path="/M-201" element={<Escalations tab="done" />} />
        <Route path="/M-202/:id" element={<AdminCase />} />
        <Route path="/M-300/:id" element={<AdminCase />} />
        <Route path="/M-310/:id" element={<AdminCase />} />
        <Route path="/M-320/:id" element={<AdminCase />} />
        <Route path="/R-100" element={<OpsReport />} />
        <Route path="/R-200" element={<VoiceReport />} />
        <Route path="/S-110" element={<Manual />} />
        <Route path="/S-120" element={<Manual />} />
        <Route path="/S-200" element={<Team scope="team" />} />
        <Route path="/S-210" element={<Team scope="all" />} />
        <Route path="/S-300" element={<Hours />} />
      </Route>

      <Route path="/C-100" element={<Ask />} />
      <Route path="/C-101" element={<Preparing />} />
      <Route path="/C-110" element={<After screen="C-110" />} />
      <Route path="/C-120" element={<After screen="C-120" />} />
      <Route path="/C-130" element={<After screen="C-130" />} />
      <Route path="/C-140" element={<After screen="C-140" />} />
      <Route path="/C-200" element={<MyTickets />} />
      <Route path="/C-300" element={<Faq />} />
      <Route path="/C-310" element={<Faq results />} />
      <Route path="/Shop" element={<Shop />} />
      <Route path="/Orders" element={<Orders />} />
      <Route path="*" element={<Navigate to="/X-100" replace />} />
    </Routes>
  );
}
