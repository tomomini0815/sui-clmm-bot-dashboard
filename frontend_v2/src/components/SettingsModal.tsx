import React, { useState } from 'react';
import { Eye, EyeOff, Save, X } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  privateKey: string;
  setPrivateKey: (val: string) => void;
  apiUrl: string;
  setApiUrl: (val: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, privateKey, setPrivateKey, apiUrl, setApiUrl }) => {
  const [showPk, setShowPk] = useState(false);
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  
  const [rangeWidth, setRangeWidth] = useState('5.0');
  const [hedgeRatio, setHedgeRatio] = useState('50');
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  if (!isOpen) return null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          privateKey,
          rangeWidth,
          hedgeRatio,
          telegramToken,
          telegramChatId
        })
      });
      const data = await response.json();
      if (data.success) {
        console.log('Settings Saved!');
      }
    } catch (err) {
      console.error('Failed to save settings to backend:', err);
    } finally {
      setIsSaving(false);
      onClose();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="glass-panel modal-content">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 600 }}>Bot Configuration</h2>
          <button style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        <div className="form-group">
          <label>Wallet Private Key (suiprivkey...)</label>
          <div className="input-wrapper">
            <input 
              type={showPk ? "text" : "password"} 
              className="input-glass" 
              placeholder="suiprivkey..." 
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
            />
            <div className="input-icon-right" onClick={() => setShowPk(!showPk)}>
              {showPk ? <EyeOff size={18} /> : <Eye size={18} />}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '16px' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Rebalance Range (%)</label>
            <input type="number" className="input-glass" value={rangeWidth} onChange={(e) => setRangeWidth(e.target.value)} step="0.1" />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Hedge Ratio (%)</label>
            <input type="number" className="input-glass" value={hedgeRatio} onChange={(e) => setHedgeRatio(e.target.value)} step="10" />
          </div>
        </div>

        <div className="form-group">
          <label>Telegram Bot Token</label>
          <div className="input-wrapper">
            <input 
              type={showTelegramToken ? "text" : "password"} 
              className="input-glass" 
              placeholder="e.g. 123456:ABC-DEF1234ghIkl..." 
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
            />
            <div className="input-icon-right" onClick={() => setShowTelegramToken(!showTelegramToken)}>
              {showTelegramToken ? <EyeOff size={18} /> : <Eye size={18} />}
            </div>
          </div>
        </div>

        <div className="form-group">
          <label>Telegram Chat ID</label>
          <input type="text" className="input-glass" placeholder="Your Chat ID" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} />
        </div>

        <div className="form-group" style={{ marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '16px' }}>
          <label style={{ color: 'var(--neon-cetus)' }}>Backend API URL (For Sharing/ngrok)</label>
          <input 
            type="text" 
            className="input-glass" 
            placeholder="http://localhost:3001" 
            value={apiUrl} 
            onChange={(e) => setApiUrl(e.target.value)} 
          />
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
            Default: http://localhost:3001. Change this if using ngrok to share.
          </p>
        </div>

        <div style={{ marginTop: '32px' }}>
          <button className="primary-btn" onClick={handleSave} disabled={isSaving}>
            <Save size={18} /> {isSaving ? 'Saving...' : 'Save Settings & Connect'}
          </button>
        </div>
      </div>
    </div>
  );
};
