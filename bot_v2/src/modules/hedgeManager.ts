import { Logger } from './logger.js';
import { LpManager } from './lpManager.js';
import { BluefinProSdk, BluefinRequestSigner, makeSigner, OrderSide, OrderType } from '@bluefin-exchange/pro-sdk';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import BigNumber from 'bignumber.js';

BigNumber.config({ EXPONENTIAL_AT: [-20, 20] });

const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

export class HedgeManager {
  private hasPosition: boolean = false;
  private currentAmount: number = 0;
  private entryPrice: number = 0;
  public hedgeDirection: 'SHORT' | 'LONG' | 'NONE' = 'NONE';
  private mode: 'simulate' | 'bluefin' = 'simulate';
  public bluefinClient: BluefinProSdk | null = null;
  private isInitialized: boolean = false;
  private currentAddress: string = '';
  private lastSyncTime: number = 0;
  public lastMarginBalance: number = 0;
  private cumulativePnl: number = 0;
  private sessionTargets: Map<string, number> = new Map();
  private lastFundingTime: number = 0;
  private readonly SIMULATED_FUNDING_RATE_8H = 0.0001;
  private cachedFundingRate: number = 0;
  private lastFundingRateFetch: number = 0;
  private readonly FUNDING_CACHE_MS = 60 * 1000;

  constructor(mode: 'simulate' | 'bluefin' = 'simulate') {
    this.mode = mode;
    Logger.info(`HedgeManager: Mode = ${mode}`);
  }

  private safeBN(value: any): BigNumber {
    if (value === undefined || value === null) return new BigNumber(0);
    if (typeof value === 'string' && value.startsWith('0x')) {
      return new BigNumber(value, 16);
    }
    return new BigNumber(value);
  }

  getMode() { return this.mode; }
  isReady() { return this.mode === 'simulate' || (this.mode === 'bluefin' && this.isInitialized); }

  async setupBluefin(keypair: Ed25519Keypair, rpcUrl: string, network: 'mainnet' | 'testnet' = 'mainnet') {
    if (this.mode === 'simulate') return;
    try {
      Logger.info(`Bluefin: Initializing for ${network}...`);
      const signer = new BluefinRequestSigner(makeSigner(keypair as any, false));
      const suiClient = new SuiClient({ url: rpcUrl });
      this.currentAddress = keypair.toSuiAddress();
      this.bluefinClient = new BluefinProSdk(signer, network as any, suiClient as any, {
        currentAccountAddress: this.currentAddress
      });
      await this.bluefinClient.initialize();
      await this.syncTimeWithServer();
      try {
        await this.bluefinClient.accountDataApi.getAccountDetails(undefined, this.getAuthHeaders());
        Logger.success(`Bluefin Account Initialized: ${this.currentAddress}`);
        this.isInitialized = true;
      } catch (checkErr: any) {
        Logger.warn(`Bluefin Account not found, onboarding...`);
        try {
          const onboardTx = await (this.bluefinClient as any).onboard();
          Logger.info(`Bluefin Onboarding Success: ${onboardTx.digest}`);
          this.isInitialized = true;
        } catch (onboardErr: any) {
          Logger.error(`Bluefin Onboarding Failed: ${onboardErr.message}`);
          this.isInitialized = true; 
        }
      }
    } catch (e: any) {
      Logger.error(`Bluefin Setup Failed: ${e.message}`);
      this.mode = 'simulate';
    }
  }

  private async syncTimeWithServer() {
    if (!this.bluefinClient) return;
    try {
      const infoRes = await (this.bluefinClient as any).exchangeDataApi.getExchangeInfo();
      const serverDate = infoRes.headers?.date;
      if (serverDate) {
        const serverTimeMs = new Date(serverDate).getTime();
        this.bluefinClient.updateCurrentTimeMs(serverTimeMs);
        this.lastSyncTime = Date.now();
      }
    } catch (e) {
      Logger.warn('Bluefin time sync failed.');
    }
  }

  private getAuthHeaders() {
    const token = (this.bluefinClient as any).getTokenResponse()?.accessToken;
    if (!token) return {};
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  async getMarginBalance(): Promise<number> {
    if (this.mode === 'simulate') return this.currentAmount * 0.5;
    if (!this.bluefinClient) return 0;
    try {
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(undefined, this.getAuthHeaders());
      const details = (detailsRes as any).data || detailsRes;
      this.lastMarginBalance = this.safeBN(details.totalAccountValueE9).dividedBy(1e9).toNumber();
      return this.lastMarginBalance;
    } catch (e) { return 0; }
  }

  async syncPositionWithBluefin(): Promise<boolean> {
    if (this.mode === 'simulate' || !this.bluefinClient) return this.hasPosition;
    try {
      if (Date.now() - this.lastSyncTime > 5 * 60 * 1000) await this.syncTimeWithServer();
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(undefined, this.getAuthHeaders());
      const details = (detailsRes as any).data || detailsRes;
      const positions = details.positions || [];
      const suiPos = positions.find((p: any) => {
        const s = String(p.symbol).toUpperCase();
        return s === 'SUI-PERP' || s === 'SUI-P' || s === 'SUI' || s.includes('SUI-');
      });
      if (suiPos) {
        const sizeBN = this.safeBN(suiPos.sizeE9);
        if (!sizeBN.isZero()) {
          const size = sizeBN.dividedBy(1e9).toNumber();
          const price = this.safeBN(suiPos.avgEntryPriceE9).dividedBy(1e9).toNumber();
          this.hasPosition = true;
          this.currentAmount = Math.abs(size * price);
          this.entryPrice = price;
          let parsedDirection = size < 0 ? 'SHORT' : 'LONG';
          if (suiPos.side && typeof suiPos.side === 'string') parsedDirection = suiPos.side.toUpperCase();
          this.hedgeDirection = parsedDirection as 'SHORT' | 'LONG';
          this.lastMarginBalance = parseFloat(details.totalAccountValueE9) / 1e9;
          return true;
        }
      }
      this.lastMarginBalance = details && details.totalAccountValueE9 ? parseFloat(details.totalAccountValueE9) / 1e9 : 0;
      this.hasPosition = false;
      this.currentAmount = 0;
      this.hedgeDirection = 'NONE';
      return false;
    } catch (e: any) { 
      Logger.warn(`Bluefin sync failed: ${e.message}`);
      return this.hasPosition; 
    }
  }

  async depositMargin(amountUsdc: number, lpManager?: LpManager): Promise<{ digest: string }> {
    if (this.mode === 'simulate' || !this.bluefinClient) return { digest: 'simulated' };
    
    try {
      const currentMargin = await this.getMarginBalance();
      if (currentMargin >= amountUsdc - 0.01) {
        Logger.info(`HedgeManager: Margin sufficient ($${currentMargin.toFixed(2)}). Skipping.`);
        return { digest: 'skipped' };
      }

      const needed = amountUsdc - currentMargin;
      const coinType = USDC_TYPE;

      Logger.info(`Bluefin: Preparing deposit for $${needed.toFixed(2)} USDC...`);
      const suiClient = (this.bluefinClient as any).suiClient;
      
      const coinsRes = await suiClient.getCoins({ owner: this.currentAddress, coinType });
      const totalUsdc = coinsRes.data.reduce((sum: number, c: any) => sum + parseInt(c.balance), 0) / 1e6;

      if (totalUsdc < needed) {
        throw new Error(`Insufficient USDC for Bluefin deposit. Have: $${totalUsdc.toFixed(2)}, Need: $${needed.toFixed(2)}`);
      }

      if (coinsRes.data.length > 1) {
        Logger.info(`Bluefin: Fragmented coins detected (${coinsRes.data.length}). Merging...`);
        const tx = new Transaction();
        const coinIds = coinsRes.data.map((c: any) => c.coinObjectId);
        const primaryCoin = coinIds[0];
        const otherCoins = coinIds.slice(1);
        
        tx.mergeCoins(tx.object(primaryCoin), otherCoins.map((id: any) => tx.object(id)));
        
        const signer = (this.bluefinClient as any).signer;
        const keypair = signer.keypair;
        
        const result = await suiClient.signAndExecuteTransaction({
          transaction: tx,
          signer: keypair,
        });
        await suiClient.waitForTransaction({ digest: result.digest });
        Logger.info(`Bluefin: Coins merged. Digest: ${result.digest}`);
      }

      Logger.info(`Bluefin: Re-initializing client...`);
      await this.bluefinClient.initialize();

      try {
        const contracts = (this.bluefinClient as any).contractsConfig;
        const tx = new Transaction();
        const amountE6 = Math.floor(needed * 1e6);
        
        const coinsRes = await suiClient.getCoins({ owner: this.currentAddress, coinType });
        const coinIds = coinsRes.data.map((c: any) => c.coinObjectId);
        const primaryCoinId = coinIds[0];
        if (coinIds.length > 1) {
          tx.mergeCoins(tx.object(primaryCoinId), coinIds.slice(1).map((id: any) => tx.object(id)));
        }
        
        const [splitCoin] = tx.splitCoins(tx.object(primaryCoinId), [tx.pure.u64(amountE6)]);
        
        tx.moveCall({
          target: `${contracts.currentContractAddress}::exchange::deposit_to_asset_bank`,
          typeArguments: [coinType],
          arguments: [
            tx.object(contracts.edsId),          
            tx.pure.string("USDC"),              
            tx.pure.address(this.currentAddress),
            tx.pure.u64(amountE6.toString()),    
            splitCoin                            
          ]
        });
        
        tx.transferObjects([splitCoin], tx.pure.address(this.currentAddress));

        const signer = (this.bluefinClient as any).signer;
        const keypair = signer.keypair;
        
        Logger.info(`Bluefin: Executing manual PTB deposit ($${needed.toFixed(2)})...`);
        const result = await suiClient.signAndExecuteTransaction({
          transaction: tx,
          signer: keypair,
        });
        
        await suiClient.waitForTransaction({ digest: result.digest });
        Logger.success(`Bluefin: Manual deposit successful! Digest: ${result.digest}`);
        return { digest: result.digest };

      } catch (e: any) {
        Logger.error(`Bluefin: Manual PTB deposit failed: ${e.message}`);
        throw e;
      }

    } catch (e: any) {
      Logger.error(`[CRITICAL] Bluefin Deposit Failed: ${e.message}`);
      throw e;
    }
  }

  async withdrawMargin(amountUsdc: number) {
    if (this.mode === 'simulate' || !this.bluefinClient) return;
    try {
      Logger.info(`Bluefin: Withdrawing $${amountUsdc.toFixed(2)} USDC...`);
      const amountRawE9 = new BigNumber(amountUsdc).times(1e9).integerValue().toString();
      await this.bluefinClient.withdraw('USDC', amountRawE9);
    } catch (e: any) {
      Logger.error(`Withdraw Margin Failed: ${e.message}`);
    }
  }

  async withdrawAllMargin() {
    if (this.mode === 'simulate' || !this.bluefinClient) return;
    try {
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(undefined, this.getAuthHeaders());
      const details = (detailsRes as any).data || detailsRes;
      const marginRaw = this.safeBN(details.totalAccountValueE9);
      if (marginRaw.isZero()) return;
      const amountUsdc = marginRaw.dividedBy(1e9).toNumber();
      await this.bluefinClient.withdraw('USDC', this.safeBN(amountUsdc).times(1e9).integerValue().toString());
    } catch (e: any) {}
  }

  async checkAndMaintainMargin(currentPrice: number) {
    if (this.mode === 'simulate' || !this.bluefinClient) return;
    try {
      await this.syncPositionWithBluefin().catch(() => {});
      if (!this.hasPosition) return;

      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(undefined, this.getAuthHeaders());
      const details = (detailsRes as any).data || detailsRes;
      
      const marginBalance = Number(this.safeBN(details.totalAccountValueE9).div(1e9).toFixed(4));
      this.lastMarginBalance = marginBalance;
      
      const positionValue = this.currentAmount;
      const marginRatio = marginBalance / (positionValue || 1);

      if (marginRatio < 0.30) {
        const topUp = positionValue * 0.20; 
        Logger.warn(`⚠️ Margin low (${(marginRatio*100).toFixed(1)}%) -> Replenishing $${topUp.toFixed(2)} USDC`);
        await this.depositMargin(topUp);
      }
    } catch (e: any) {
      Logger.error(`Margin Maintenance Failed: ${e.message}`);
    }
  }

  async openHedge(amountUsdc: number, currentPrice: number, side: 'SHORT' | 'LONG' = 'SHORT', sessionId?: string): Promise<{ digest: string; gasCostUsdc: number }> {
    if (sessionId) this.sessionTargets.set(sessionId, (this.sessionTargets.get(sessionId) || 0) + amountUsdc);
    if (this.mode === 'simulate') {
      this.hasPosition = true; this.currentAmount = amountUsdc; this.entryPrice = currentPrice; this.hedgeDirection = side;
      return { digest: 'simulated', gasCostUsdc: 0 };
    }
    if (!this.bluefinClient) throw new Error('Not initialized');
    
    // 証拠金確保
    const marginBalance = await this.getMarginBalance();
    if (marginBalance < amountUsdc * 0.55) {
      await this.depositMargin(amountUsdc * 0.55);
    }
    
    let quantity = Math.floor(amountUsdc / currentPrice);
    if (quantity < 1) quantity = 1;
    
    Logger.info(`Bluefin: Opening ${side} position of size ${quantity} SUI ($${(quantity * currentPrice).toFixed(2)})`);
    
    const response = await this.bluefinClient.createOrder({
      symbol: 'SUI-PERP', side: side === 'SHORT' ? OrderSide.Short : OrderSide.Long, type: OrderType.Market,
      quantityE9: new BigNumber(quantity).times(1e9).toString(), priceE9: '0',
      leverageE9: this.safeBN(3).times(1e9).toString(), isIsolated: true,
      expiresAtMillis: Date.now() + 600000, clientOrderId: Date.now().toString(),
    });
    this.hasPosition = true; this.currentAmount = quantity * currentPrice; this.entryPrice = currentPrice; this.hedgeDirection = side;
    return { digest: (response as any).hash || 'success', gasCostUsdc: 0 };
  }

  async closeHedge(currentPrice: number, sessionId?: string): Promise<{ pnl: number, digest: string }> {
    if (sessionId) this.sessionTargets.set(sessionId, 0);
    await this.syncPositionWithBluefin().catch(() => {});
    if (!this.hasPosition) return { pnl: 0, digest: '' };
    const pnl = this.calculateCurrentPnl(currentPrice);
    if (this.mode === 'bluefin' && this.bluefinClient) {
      try {
        const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(undefined, this.getAuthHeaders());
        const suiPos = ((detailsRes as any).data || detailsRes).positions.find((p: any) => String(p.symbol).toUpperCase().includes('SUI'));
        if (suiPos && suiPos.sizeE9 !== '0') {
          const response = await this.bluefinClient.createOrder({
            symbol: suiPos.symbol, side: this.safeBN(suiPos.sizeE9).isNegative() ? OrderSide.Long : OrderSide.Short,
            type: OrderType.Market, quantityE9: this.safeBN(suiPos.sizeE9).abs().toString(), priceE9: '0',
            leverageE9: suiPos.leverageE9, isIsolated: true, reduceOnly: true,
            expiresAtMillis: Date.now() + 600000, clientOrderId: 'close_' + Date.now().toString(),
          });
          this.hasPosition = false; this.currentAmount = 0; this.hedgeDirection = 'NONE';
          return { pnl, digest: (response as any).hash || 'success' };
        }
      } catch (e: any) {
        Logger.error(`Bluefin closeHedge failed: ${e.message}`);
        if (e.message.includes('Position not found') || e.message.includes('404')) {
          this.hasPosition = false;
          this.currentAmount = 0;
          this.hedgeDirection = 'NONE';
        }
        throw e;
      }
    }
    this.hasPosition = false; this.currentAmount = 0; this.hedgeDirection = 'NONE';
    this.cumulativePnl += pnl;
    return { pnl, digest: 'simulated' };
  }

  calculateCurrentPnl(currentPrice: number): number {
    if (!this.hasPosition || this.entryPrice <= 0) return 0;
    const ratio = (this.entryPrice - currentPrice) / this.entryPrice;
    return this.hedgeDirection === 'SHORT' ? this.currentAmount * ratio : this.currentAmount * -ratio;
  }

  async getFundingRate(): Promise<number> {
    if (Date.now() - this.lastFundingRateFetch < this.FUNDING_CACHE_MS) return this.cachedFundingRate;
    if (this.mode === 'simulate') return this.SIMULATED_FUNDING_RATE_8H / 8;
    try {
      const resp = await fetch('https://dapi.api.sui-prod.bluefin.io/fundingRate?symbol=SUI-PERP');
      if (resp.ok) {
        const data = await resp.json();
        this.cachedFundingRate = parseFloat(data?.fundingRate || '0') / 8;
        this.lastFundingRateFetch = Date.now();
        return this.cachedFundingRate;
      }
    } catch (e) {}
    return this.cachedFundingRate;
  }

  async getMarginRatio(): Promise<number> {
    if (!this.hasPosition || this.currentAmount <= 0) return 999;
    const marginBalance = await this.getMarginBalance();
    return (marginBalance / this.currentAmount) * 100;
  }

  calcHedgeDelta(currentPrice: number, lowerBound: number, upperBound: number, lpValueUsdc: number, lpSuiAmount?: number): { delta: number; hedgeUsd: number; } {
    if (lpSuiAmount !== undefined && lpSuiAmount > 0) {
      const hedgeUsd = lpSuiAmount * currentPrice * 0.50; // 仕様書: LPのSUI量の50%をヘッジ
      const delta = lpValueUsdc > 0 ? hedgeUsd / lpValueUsdc : 0.25;
      return { delta, hedgeUsd };
    }

    if (lowerBound <= 0 || upperBound <= lowerBound || lpValueUsdc <= 0) return { delta: 0.25, hedgeUsd: lpValueUsdc * 0.25 };
    
    // Uniswap v3 Formula x 50%
    let delta = currentPrice <= lowerBound ? 0 : currentPrice >= upperBound ? 1 : (Math.sqrt(currentPrice) - Math.sqrt(lowerBound)) / (Math.sqrt(upperBound) - Math.sqrt(lowerBound));
    delta = Math.max(0, Math.min(1, delta)) * 0.50; // ヘッジ比率50%
    return { delta, hedgeUsd: delta * lpValueUsdc };
  }

  async adjustPosition(newNotionalUsdc: number, currentPrice: number, sessionId: string): Promise<{ digest: string }> {
    this.sessionTargets.set(sessionId, newNotionalUsdc);
    
    let totalTargetUsdc = 0;
    for (const val of this.sessionTargets.values()) {
      totalTargetUsdc += val;
    }

    const diff = totalTargetUsdc - this.currentAmount;

    if (Math.abs(diff) / (this.currentAmount || 1) < 0.10) return { digest: 'skipped' };
    
    if (this.mode === 'simulate') { 
      this.currentAmount = totalTargetUsdc; 
      return { digest: 'simulated' }; 
    }

    if (diff > 0) {
      Logger.info(`🛡️ Adjusting Hedge (Increase): $${this.currentAmount.toFixed(2)} → $${totalTargetUsdc.toFixed(2)}`);
      return await this.openHedge(diff, currentPrice, this.hedgeDirection as 'SHORT' | 'LONG' || 'SHORT');
    } else {
      const reduceAmount = Math.abs(diff);
      const oppositeSide = this.hedgeDirection === 'SHORT' ? 'LONG' : 'SHORT';
      
      Logger.info(`🛡️ Adjusting Hedge (Decrease): $${this.currentAmount.toFixed(2)} → $${totalTargetUsdc.toFixed(2)}`);
      if (reduceAmount < 1.0) return { digest: 'skipped_too_small' };

      const res = await this.openHedge(reduceAmount, currentPrice, oppositeSide);
      this.currentAmount = totalTargetUsdc; 
      return res;
    }
  }

  clearSessionTarget(sessionId: string) {
    this.sessionTargets.delete(sessionId);
  }

  getStatus(currentPrice: number) {
    return {
      active: this.hasPosition, mode: this.mode, direction: this.hedgeDirection,
      size: Number(this.currentAmount.toFixed(2)), entryPrice: Number(this.entryPrice.toFixed(4)),
      currentPnl: Number(this.calculateCurrentPnl(currentPrice).toFixed(4)),
      cumulativePnl: Number(this.cumulativePnl.toFixed(4)),
      marginBalance: Number(this.lastMarginBalance.toFixed(2)),
    };
  }

  serialize() { return { hasPosition: this.hasPosition, currentAmount: this.currentAmount, entryPrice: this.entryPrice, hedgeDirection: this.hedgeDirection, cumulativePnl: this.cumulativePnl }; }
  restore(data: any) { if (!data) return; this.hasPosition = data.hasPosition; this.currentAmount = data.currentAmount; this.entryPrice = data.entryPrice; this.hedgeDirection = data.hedgeDirection; this.cumulativePnl = data.cumulativePnl; }
}
