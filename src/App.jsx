import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import Layout from './components/Layout';
import InventoryCalculator from './pages/InventoryCalculator';
import FbcCalculator from './pages/FbcCalculator';
import Dashboard from './pages/Dashboard';
import SoldOut from './pages/SoldOut';
import SoldOutRate from './pages/SoldOutRate';
import SoldOutExclude from './pages/SoldOutExclude';
import SoldOutHistory from './pages/SoldOutHistory';
import Incoming from './pages/Incoming';
import SuppliesList from './pages/SuppliesList';
import SuppliesOrder from './pages/SuppliesOrder';
import IssueManagement from './pages/IssueManagement';
import ProductImprovement from './pages/ProductImprovement';
import CertificationManagement from './pages/CertificationManagement';
import OrderBook from './pages/OrderBook';
import OrderRequest from './pages/OrderRequest';
import OrderRecommend from './pages/OrderRecommend';
import FbcItems from './pages/FbcItems';
import FbcPalletCalculator from './pages/FbcPalletCalculator';
import Home from './pages/Home';
import Sales from './pages/Sales';
import SalesForecast from './pages/SalesForecast';
import Placeholder from './pages/Placeholder';
import IncheonIncoming from './pages/IncheonIncoming';
import SoldOutAnalysis from './pages/SoldOutAnalysis';
import SoldOutAnalysisHistory from './pages/SoldOutAnalysisHistory';
import SoldOutAnalysisExclude from './pages/SoldOutAnalysisExclude';
import SoldOutAnalysisRate from './pages/SoldOutAnalysisRate';
import SoldOutAnalysisDelayCause from './pages/SoldOutAnalysisDelayCause';
import SoldOutAnalysisUpload from './pages/SoldOutAnalysisUpload';
import ActivityLog from './pages/ActivityLog';
import CnSettlementUpload from './pages/CnSettlementUpload';
import CnSettlementDashboard from './pages/CnSettlementDashboard';
import CnSettlementHistory from './pages/CnSettlementHistory';

// 딥링크(주소창 직접 접속·외부 링크)로 최초 접속하면 홈으로 보냄.
// 단, 새로고침(reload)·뒤로/앞으로(back_forward)는 현재 페이지 유지.
function InitialRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    let navType = 'navigate';
    const entries = performance.getEntriesByType('navigation');
    if (entries.length > 0) {
      navType = entries[0].type; // 'navigate' | 'reload' | 'back_forward' | 'prerender'
    } else if (performance.navigation) {
      // 구형 브라우저 폴백 (0=navigate, 1=reload, 2=back_forward)
      navType = ['navigate', 'reload', 'back_forward'][performance.navigation.type] || 'navigate';
    }
    if (navType === 'navigate' && window.location.pathname !== '/') {
      navigate('/', { replace: true });
    }
  }, []); // 전체 페이지 로드 시 1회만 실행
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <InitialRedirect />
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inventory" element={<InventoryCalculator />} />
          <Route path="/inventory/incoming" element={<Incoming />} />
          <Route path="/inventory/recommend" element={<OrderRecommend />} />
          <Route path="/inventory/order" element={<OrderRequest />} />
          <Route path="/inventory/orderbook" element={<OrderBook />} />
          <Route path="/inventory/incheon" element={<IncheonIncoming />} />
          <Route path="/fbc" element={<FbcCalculator />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/fbc/items" element={<FbcItems />} />
          <Route path="/fbc/pallet" element={<FbcPalletCalculator />} />
          <Route path="/sales" element={<Sales />} />
          <Route path="/sales/forecast" element={<SalesForecast />} />
          <Route path="/soldout" element={<SoldOut />} />
          <Route path="/soldout/rate" element={<SoldOutRate />} />
          <Route path="/soldout/exclude" element={<SoldOutExclude />} />
          <Route path="/soldout/history" element={<SoldOutHistory />} />
          <Route path="/soldout-analysis" element={<SoldOutAnalysis />} />
          <Route path="/soldout-analysis/history" element={<SoldOutAnalysisHistory />} />
          <Route path="/soldout-analysis/exclude" element={<SoldOutAnalysisExclude />} />
          <Route path="/soldout-analysis/rate" element={<SoldOutAnalysisRate />} />
          <Route path="/soldout-analysis/delay-cause" element={<SoldOutAnalysisDelayCause />} />
          <Route path="/soldout-analysis/upload" element={<SoldOutAnalysisUpload />} />
          <Route path="/issue" element={<IssueManagement />} />
          <Route path="/issue/improvement" element={<ProductImprovement />} />
          <Route path="/issue/certification" element={<CertificationManagement />} />
          <Route path="/supplies" element={<SuppliesList />} />
          <Route path="/supplies/order" element={<SuppliesOrder />} />
          <Route path="/activity-log" element={<ActivityLog />} />
          <Route path="/cn-settlement/upload" element={<CnSettlementUpload />} />
          <Route path="/cn-settlement/dashboard" element={<CnSettlementDashboard />} />
          <Route path="/cn-settlement/history" element={<CnSettlementHistory />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
