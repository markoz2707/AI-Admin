import React, { useEffect, useState } from 'react';
import {
  Grid,
  Paper,
  Typography,
  Box,
  Card,
  CardContent,
  LinearProgress,
  Chip,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import { Dns, Terminal, Lock, SmartToy } from '@mui/icons-material';

function Dashboard({
  goto,
  selectedServerId,
  setSelectedServerId,
  servers,
  serversLoading,
  serversError,
}) {
  const [audit, setAudit] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(null);

  const api = window.api;

  useEffect(() => {
    const loadAudit = async () => {
      if (!api || !api.audit) {
        setAuditError('Kanał audit:* nie jest dostępny');
        return;
      }
      try {
        setAuditLoading(true);
        setAuditError(null);
        const res = await api.audit.list(20);
        if (res && res.error) {
          setAuditError(res.error.message || 'Błąd podczas ładowania audytu');
          setAudit([]);
        } else {
          setAudit(Array.isArray(res) ? res : []);
        }
      } catch (err) {
        console.error('audit:list error', err);
        setAuditError('Błąd podczas ładowania audytu');
        setAudit([]);
      } finally {
        setAuditLoading(false);
      }
    };

    loadAudit();
  }, [api]);

  const stats = {
    totalServers: servers.length,
    onlineServers: servers.filter((s) => s.status === 'online').length,
    totalPasswords: 0, // Można zasilić z credentials:list, jeśli potrzebne
    recentTasks: audit.length,
  };

  const StatCard = ({ title, value, icon, color }) => (
    <Card sx={{ height: '100%', backgroundColor: 'background.paper' }}>
      <CardContent>
        <Box display="flex" alignItems="center" mb={1}>
          <Box color={color} mr={1}>
            {icon}
          </Box>
          <Typography variant="h6" component="div">
            {title}
          </Typography>
        </Box>
        <Typography variant="h4" component="div" color={color}>
          {serversLoading ? '...' : value}
        </Typography>
      </CardContent>
    </Card>
  );

  const handleServerClick = (serverId) => {
    setSelectedServerId(serverId);
    goto('console');
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Dashboard
      </Typography>

      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Razem serwerów"
            value={stats.totalServers}
            icon={<Dns />}
            color="primary.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Serwery online"
            value={stats.onlineServers}
            icon={<Terminal />}
            color="success.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Zapisane hasła"
            value={stats.totalPasswords}
            icon={<Lock />}
            color="warning.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Zdarzenia audytowe"
            value={stats.recentTasks}
            icon={<SmartToy />}
            color="secondary.main"
          />
        </Grid>
      </Grid>

      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2, backgroundColor: 'background.paper' }}>
            <Typography variant="h6" gutterBottom>
              Status serwerów
            </Typography>
            {serversLoading ? (
              <LinearProgress />
            ) : serversError ? (
              <Typography color="error">{serversError}</Typography>
            ) : (
              <Box>
                {servers.length === 0 ? (
                  <Typography color="text.secondary">
                    Brak skonfigurowanych serwerów
                  </Typography>
                ) : (
                  servers.map((server) => (
                    <Box
                      key={server.id}
                      display="flex"
                      justifyContent="space-between"
                      alignItems="center"
                      mb={1}
                      sx={{
                        cursor: 'pointer',
                        '&:hover': { backgroundColor: 'rgba(255,255,255,0.04)' },
                        p: 1,
                        borderRadius: 1,
                      }}
                      onClick={() => handleServerClick(server.id)}
                    >
                      <Box>
                        <Typography>{server.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {server.environment || server.env || 'brak środowiska'}
                        </Typography>
                      </Box>
                      <Box display="flex" alignItems="center" gap={1}>
                        <Chip
                          size="small"
                          label={server.status || 'unknown'}
                          color={
                            server.status === 'online'
                              ? 'success'
                              : server.status === 'offline'
                              ? 'default'
                              : 'warning'
                          }
                        />
                        {selectedServerId === server.id && (
                          <Chip size="small" label="Wybrany" color="primary" variant="outlined" />
                        )}
                      </Box>
                    </Box>
                  ))
                )}
              </Box>
            )}
          </Paper>
        </Grid>

        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2, backgroundColor: 'background.paper' }}>
            <Typography variant="h6" gutterBottom>
              Ostatnie aktywności (audit)
            </Typography>
            {auditLoading && <LinearProgress sx={{ mb: 1 }} />}
            {auditError && (
              <Typography color="text.secondary">
                {auditError} – logi audytowe mogą być jeszcze w trakcie implementacji.
              </Typography>
            )}
            {!auditLoading && !auditError && audit.length === 0 && (
              <Typography color="text.secondary">
                Brak danych audytowych do wyświetlenia.
              </Typography>
            )}
            {!auditLoading && audit.length > 0 && (
              <List dense>
                {audit.slice(0, 10).map((entry) => (
                  <ListItem key={entry.id}>
                    <ListItemText
                      primary={`${entry.actionType || entry.action} – ${entry.details?.resourceType || ''} ${entry.details?.resourceId || ''}`}
                      secondary={new Date(entry.timestamp).toLocaleString()}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
}

export default Dashboard;