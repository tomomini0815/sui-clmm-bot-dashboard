import React from 'react';
import { createRoot } from 'react-dom/client';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';
import App from './App.tsx';
import './index.css';
import '@mysten/dapp-kit/dist/index.css';

const { networkConfig } = createNetworkConfig({
  mainnet: { url: 'https://fullnode.mainnet.sui.io:443' },
  testnet: { url: 'https://fullnode.testnet.sui.io:443' },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SuiClientProvider networks={networkConfig} defaultNetwork="mainnet">
      <WalletProvider>
        <App />
      </WalletProvider>
    </SuiClientProvider>
  </React.StrictMode>,
);
