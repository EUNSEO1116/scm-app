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
import OrderBook from './pages/OrderBook';
import OrderRequest from './pages/OrderRequest';
import FbcItems from './pages/FbcItems';
import Home from './pages/Home';
import Sales from './pages/Sales';
import Placeholder from './pages/Placeholder';
import IncheonIncoming from './pages/IncheonIncoming';
import ClosedProducts from './pages/ClosedProducts';

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inventory" element={<InventoryCalculator />} />
          <Route path="/inventory/incoming" element={<Incoming />} />
          <Route path="/inventory/order" element={<OrderRequest />} />
          <Route path="/inventory/orderbook" element={<OrderBook />} />
          <Route path="/inventory/incheon" element={<IncheonIncoming />} />
          <Route path="/inventory/closed" element={<ClosedProducts />} />
          <Route path="/fbc" element={<FbcCalculator />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/fbc/items" element={<FbcItems />} />
          <Route path="/sales" element={<Sales />} />
          <Route path="/soldout" element={<SoldOut />} />
          <Route path="/soldout/rate" element={<SoldOutRate />} />
          <Route path="/soldout/exclude" element={<SoldOutExclude />} />
          <Route path="/soldout/history" element={<SoldOutHistory />} />
          <Route path="/issue" element={<IssueManagement />} />
          <Route path="/issue/improvement" element={<ProductImprovement />} />
          <Route path="/supplies" element={<SuppliesList />} />
          <Route path="/supplies/order" element={<SuppliesOrder />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
