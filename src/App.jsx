import { BrowserRouter, Routes, Route } from 'react-router-dom';
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
import ClosedProducts from './pages/ClosedProducts';
import SoldOutAnalysis from './pages/SoldOutAnalysis';
import SoldOutAnalysisHistory from './pages/SoldOutAnalysisHistory';
import SoldOutAnalysisExclude from './pages/SoldOutAnalysisExclude';
import SoldOutAnalysisRate from './pages/SoldOutAnalysisRate';
import SoldOutAnalysisUpload from './pages/SoldOutAnalysisUpload';
import ActivityLog from './pages/ActivityLog';
import CnSettlementUpload from './pages/CnSettlementUpload';
import CnSettlementDashboard from './pages/CnSettlementDashboard';
import CnSettlementHistory from './pages/CnSettlementHistory';

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inventory" element={<InventoryCalculator />} />
          <Route path="/inventory/incoming" element={<Incoming />} />
          <Route path="/inventory/recommend" element={<OrderRecommend />} />
          <Route path="/inventory/order" element={<OrderRequest />} />
          <Route path="/inventory/orderbook" element={<OrderBook />} />
          <Route path="/inventory/incheon" element={<IncheonIncoming />} />
          <Route path="/inventory/closed" element={<ClosedProducts />} />
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
