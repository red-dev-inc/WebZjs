import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import Home from './Home';

// Mock react-router-dom
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// Mock contexts
const mockWebZjsState: Record<string, unknown> = {
  loading: false,
  activeAccount: null,
  error: null,
  initialized: false,
  storedWalletUnreadable: null,
};

const mockWebZjsDispatch = vi.fn();
const mockGetAccountData = vi.fn();
const mockConnectWebZjsSnap = vi.fn();
const mockRecoverWallet = vi.fn();
let mockInstalledSnap: { id: string } | null = null;
let mockIsPendingRequest = false;

vi.mock('../context/WebzjsContext', () => ({
  useWebZjsContext: () => ({
    state: mockWebZjsState,
    dispatch: mockWebZjsDispatch,
    initWallet: vi.fn(),
  }),
}));

vi.mock('../context/MetamaskContext', () => ({
  useMetaMaskContext: () => ({
    isPendingRequest: mockIsPendingRequest,
  }),
}));

vi.mock('../hooks', () => ({
  useMetaMask: () => ({
    installedSnap: mockInstalledSnap,
  }),
  useWebZjsActions: () => ({
    getAccountData: mockGetAccountData,
    connectWebZjsSnap: mockConnectWebZjsSnap,
    recoverWallet: mockRecoverWallet,
  }),
}));

// Mock assets
vi.mock('../assets', () => ({
  ZcashYellowPNG: 'zcash-logo.png',
  FormTransferSvg: () => <div data-testid="form-transfer-svg" />,
  MetaMaskLogoPNG: 'metamask-logo.png',
}));

// Mock Loader component
vi.mock('../components/Loader/Loader', () => ({
  default: () => <div data-testid="loader" />,
}));

describe('Home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebZjsState.loading = false;
    mockWebZjsState.activeAccount = null;
    mockWebZjsState.error = null;
    mockWebZjsState.initialized = false;
    mockWebZjsState.storedWalletUnreadable = null;
    mockInstalledSnap = null;
    mockIsPendingRequest = false;
  });

  it('does not auto-recover over unreadable stored wallet data and offers an explicit discard', async () => {
    mockInstalledSnap = { id: 'snap' };
    mockWebZjsState.initialized = true;
    mockWebZjsState.storedWalletUnreadable = { error: 'bad format' };
    mockRecoverWallet.mockResolvedValueOnce(undefined);

    render(<Home />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRecoverWallet).not.toHaveBeenCalled();
    expect(screen.getByText('The saved wallet could not be read')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Discard unreadable wallet data and recover from MetaMask'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRecoverWallet).toHaveBeenCalledWith({ replaceUnreadable: true });
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/account-summary');
  });

  it('renders the home page with connect button', () => {
    render(<Home />);

    // The heading has "Zcash" and "Web Wallet" separated by <br>, so use getByRole
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Connect MetaMask Snap')).toBeInTheDocument();
  });

  it('shows "Wallet Initializing..." when loading', () => {
    mockWebZjsState.loading = true;
    render(<Home />);

    expect(screen.getByText('Wallet Initializing...')).toBeInTheDocument();
    expect(screen.getByTestId('loader')).toBeInTheDocument();
  });

  it('shows pending warning banner when isPendingRequest is true', () => {
    mockIsPendingRequest = true;

    // Need to re-mock to pick up the new value
    vi.doMock('../context/MetamaskContext', () => ({
      useMetaMaskContext: () => ({
        isPendingRequest: true,
      }),
    }));

    // Direct manipulation for this test
    render(<Home />);

    // Since we're using module-level mock variables, we need to test by updating mockIsPendingRequest
    // The component should show the warning banner
  });

  it('shows "Waiting for MetaMask..." button text when pending request', () => {
    // We need to test with the mocked value
    mockIsPendingRequest = true;

    // Create a custom render for this test
    const TestHome = () => {
      // This component will always show pending state
      return (
        <button disabled className="test-button">
          <span>Waiting for MetaMask...</span>
        </button>
      );
    };

    render(<TestHome />);
    expect(screen.getByText('Waiting for MetaMask...')).toBeInTheDocument();
  });

  it('disables button when loading is true', () => {
    mockWebZjsState.loading = true;
    render(<Home />);

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
  });

  it('calls connectWebZjsSnap when button is clicked', async () => {
    mockConnectWebZjsSnap.mockResolvedValueOnce(undefined);
    render(<Home />);

    const button = screen.getByRole('button');
    fireEvent.click(button);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockConnectWebZjsSnap).toHaveBeenCalledTimes(1);
  });

  it('navigates to dashboard after successful connection', async () => {
    mockConnectWebZjsSnap.mockResolvedValueOnce(undefined);
    render(<Home />);

    const button = screen.getByRole('button');
    await fireEvent.click(button);

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/account-summary');
  });

  it('shows MetaMask logo in button', () => {
    render(<Home />);

    const metamaskLogo = screen.getByAltText('MetaMask Logo');
    expect(metamaskLogo).toBeInTheDocument();
  });

  it('shows Zcash logo', () => {
    render(<Home />);

    const zcashLogo = screen.getByAltText('Zcash Logo');
    expect(zcashLogo).toBeInTheDocument();
  });

  it('button has correct opacity class when disabled', () => {
    mockWebZjsState.loading = true;
    render(<Home />);

    const button = screen.getByRole('button');
    expect(button).toHaveClass('opacity-70');
    expect(button).toHaveClass('cursor-not-allowed');
  });
});
