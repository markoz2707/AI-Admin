import React, { useState, useEffect, useCallback } from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import {
  CssBaseline,
  Box,
  Drawer,
  AppBar,
  Toolbar,
  List,
  Typography,
  Divider,
  IconButton,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Chip,
} from '@mui/material';
import {
  Menu,
  ChevronLeft,
  Dashboard as DashboardIcon,
  Dns,
  Terminal,
  SmartToy,
  Lock,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import Dashboard from './components/Dashboard';
import ServerList from './components/ServerList';
import ServerConsole from './components/ServerConsole';
import LLMPrompt from './components/LLMPrompt';
import PasswordManager from './components/PasswordManager';
import Settings from './components/Settings';
import Login from './components/Login';

const drawerWidth = 240;

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#90caf9',
    },
    secondary: {
      main: '#f48fb1',
    },
    background: {
      default: '#121212',
      paper: '#1e1e1e',
    },
  },
});

const menuItems = [
  { text: 'Dashboard', icon: <DashboardIcon />, view: 'dashboard' },
  { text: 'Serwery', icon: <Dns />, view: 'servers' },
  { text: 'Konsola', icon: <Terminal />, view: 'console' },
  { text: 'LLM', icon: <SmartToy />, view: 'llm' },
  { text: 'Hasła', icon: <Lock />, view: 'passwords' },
  { text: 'Ustawienia', icon: <SettingsIcon />, view: 'settings' },
];

function App() {
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [activeView, setActiveView] = useState('dashboard');

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [currentUserError, setCurrentUserError] = useState(null);
  const [currentUserLoading, setCurrentUserLoading] = useState(true);

  const [servers, setServers] = useState([]);
  const [serversLoading, setServersLoading] = useState(false);
  const [serversError, setServersError] = useState(null);

  const [selectedServerId, setSelectedServerId] = useState(null);

  const api = window.api;

  const goto = useCallback((view) => {
    setActiveView(view);
  }, []);

  const loadCurrentUser = useCallback(async () => {
    if (!api || !api.auth) {
      setCurrentUserLoading(false);
      return;
    }
    try {
      setCurrentUserLoading(true);
      setCurrentUserError(null);
      const res = await api.auth.getCurrentUser();
      if (res && res.error) {
        setCurrentUser(null);
        setIsAuthenticated(false);
        setCurrentUserError(res.error.message || 'Błąd pobierania użytkownika');
      } else if (res && res.user) {
        setCurrentUser(res.user);
        setIsAuthenticated(true);
      } else {
        setCurrentUser(null);
        setIsAuthenticated(false);
      }
    } catch (err) {
      console.error('auth:getCurrentUser error', err);
      setCurrentUserError('Błąd pobierania bieżącego użytkownika');
      setCurrentUser(null);
      setIsAuthenticated(false);
    } finally {
      setCurrentUserLoading(false);
    }
  }, [api]);

  const handleLoginSuccess = (user, sessionToken) => {
    setCurrentUser(user);
    setIsAuthenticated(true);
    setCurrentUserError(null);
  };

  const loadServers = useCallback(async () => {
    if (!api || !api.servers) return;
    try {
      setServersLoading(true);
      setServersError(null);
      const res = await api.servers.list();
      if (res && res.error) {
        setServersError(res.error.message || 'Błąd podczas ładowania serwerów');
        setServers([]);
      } else {
        setServers(Array.isArray(res) ? res : []);
      }
    } catch (err) {
      console.error('servers:list error', err);
      setServersError('Błąd podczas ładowania serwerów');
      setServers([]);
    } finally {
      setServersLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadCurrentUser();
  }, [loadCurrentUser]);

  useEffect(() => {
    if (isAuthenticated) {
      loadServers();
    }
  }, [isAuthenticated, loadServers]);

  const handleDrawerOpen = () => {
    setDrawerOpen(true);
  };

  const handleDrawerClose = () => {
    setDrawerOpen(false);
  };

  const renderView = () => {
    const common = {
      goto,
      selectedServerId,
      setSelectedServerId,
      currentUser,
    };

    switch (activeView) {
      case 'dashboard':
        return (
          <Dashboard
            {...common}
            servers={servers}
            serversLoading={serversLoading}
            serversError={serversError}
          />
        );
      case 'servers':
        return (
          <ServerList
            {...common}
            servers={servers}
            serversLoading={serversLoading}
            serversError={serversError}
            reloadServers={loadServers}
          />
        );
      case 'console':
        return (
          <ServerConsole
            {...common}
          />
        );
      case 'llm':
        return (
          <LLMPrompt
            {...common}
            servers={servers}
          />
        );
      case 'passwords':
        return (
          <PasswordManager
            currentUser={currentUser}
          />
        );
      case 'settings':
        return (
          <Settings
            currentUser={currentUser}
          />
        );
      default:
        return (
          <Dashboard
            {...common}
            servers={servers}
            serversLoading={serversLoading}
            serversError={serversError}
          />
        );
    }
  };

  // Show loading screen while checking authentication
  if (currentUserLoading) {
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <Box
          sx={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'background.default',
          }}
        >
          <Typography variant="h6" color="text.secondary">
            Ładowanie...
          </Typography>
        </Box>
      </ThemeProvider>
    );
  }

  // Show login screen if not authenticated
  if (!isAuthenticated) {
    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <Login onLoginSuccess={handleLoginSuccess} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <Box sx={{ display: 'flex' }}>
        <AppBar
          position="fixed"
          sx={{
            width: drawerOpen ? `calc(100% - ${drawerWidth}px)` : '100%',
            ml: drawerOpen ? `${drawerWidth}px` : 0,
            transition: (theme) =>
              theme.transitions.create(['width', 'margin'], {
                easing: theme.transitions.easing.sharp,
                duration: theme.transitions.duration.leavingScreen,
              }),
          }}
        >
          <Toolbar sx={{ display: 'flex', justifyContent: 'space-between' }}>
            <Box display="flex" alignItems="center">
              <IconButton
                color="inherit"
                aria-label="open drawer"
                onClick={handleDrawerOpen}
                edge="start"
                sx={{
                  marginRight: 3,
                  ...(drawerOpen && { display: 'none' }),
                }}
              >
                <Menu />
              </IconButton>
              <Typography variant="h6" noWrap component="div">
                AI Admin Console
              </Typography>
            </Box>
            <Box display="flex" alignItems="center" gap={1}>
              {currentUserLoading && (
                <Typography variant="body2" color="inherit">
                  Ładowanie użytkownika...
                </Typography>
              )}
              {currentUser && (
                <Chip
                  size="small"
                  color={currentUser.role === 'admin' ? 'secondary' : 'default'}
                  label={`${currentUser.username} (${currentUser.role || 'brak roli'})`}
                />
              )}
              {currentUserError && (
                <Chip
                  size="small"
                  color="warning"
                  label="Brak informacji o użytkowniku"
                />
              )}
            </Box>
          </Toolbar>
        </AppBar>

        <Drawer
          sx={{
            width: drawerWidth,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: drawerWidth,
              boxSizing: 'border-box',
            },
          }}
          variant="persistent"
          anchor="left"
          open={drawerOpen}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              padding: (theme) => theme.spacing(0, 1),
              minHeight: 64,
            }}
          >
            <IconButton onClick={handleDrawerClose}>
              <ChevronLeft />
            </IconButton>
          </Box>
          <Divider />
          <List>
            {menuItems.map((item) => (
              <ListItem key={item.view} disablePadding>
                <ListItemButton
                  selected={activeView === item.view}
                  onClick={() => goto(item.view)}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.text} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Drawer>

        <Box
          component="main"
          sx={{
            flexGrow: 1,
            bgcolor: 'background.default',
            p: 3,
            width: drawerOpen ? `calc(100% - ${drawerWidth}px)` : '100%',
            transition: (theme) =>
              theme.transitions.create('width', {
                easing: theme.transitions.easing.sharp,
                duration: theme.transitions.duration.leavingScreen,
              }),
          }}
        >
          <Toolbar />
          {renderView()}
        </Box>
      </Box>
    </ThemeProvider>
  );
}

export default App;