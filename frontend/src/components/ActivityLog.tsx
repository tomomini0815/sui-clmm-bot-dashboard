import React from 'react';
import { Activity, ArrowRightLeft, DollarSign, CheckCircle } from 'lucide-react';

const mockLogs = [
  { id: 1, time: '14:24:05', action: 'Range Check', details: 'SUI price $1.261 (In range)', status: 'Success', icon: <Activity size={16} color="var(--neon-cetus)" /> },
  { id: 2, time: '14:15:30', action: 'Fee Collection', details: 'Collected 1.25 USDC, 0.45 SUI', status: '+ Earned', icon: <DollarSign size={16} color="#00f0ff" /> },
  { id: 3, time: '13:00:12', action: 'Rebalance Executed', details: 'Reset range to $1.24 - $1.28', status: 'Completed', icon: <ArrowRightLeft size={16} color="var(--neon-cetus)" /> },
  { id: 4, time: '13:00:05', action: 'Hedge Adjusted', details: 'Short position increased by 10 SUI', status: 'Completed', icon: <CheckCircle size={16} color="var(--neon-cetus)" /> },
  { id: 5, time: '12:05:00', action: 'Bot Started', details: 'Connected to Cetus Pool 0x123...abc', status: 'Active', icon: <Activity size={16} color="var(--neon-cetus)" /> },
];

export const ActivityLog: React.FC = () => {
  return (
    <div className="glass-panel" style={{ marginTop: '24px' }}>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '16px' }}>Terminal Logs</h2>
      
      <div style={{ overflowX: 'auto' }}>
        <table className="log-table">
          <thead>
            <tr>
              <th style={{ width: '120px' }}>Time</th>
              <th style={{ width: '180px' }}>Action</th>
              <th>Details</th>
              <th style={{ width: '120px', textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {mockLogs.map((log) => (
              <tr key={log.id}>
                <td style={{ color: 'var(--text-muted)' }}>{log.time}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {log.icon}
                    <span>{log.action}</span>
                  </div>
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{log.details}</td>
                <td style={{ textAlign: 'right', color: log.status.includes('+') ? 'var(--neon-cetus)' : 'var(--text-main)' }}>
                  {log.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
