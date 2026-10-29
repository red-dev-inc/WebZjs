import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ZcashPNG } from '../../assets';

const Header = (): React.JSX.Element => {
  const location = useLocation();
  const isHomePage = location.pathname === '/';

  return (
    <header className="font-inter h-[60px] w-full px-16 flex items-center justify-between bg-transparent py-3 border-b border-neutral-200">
      <Link to={'/'}>
        <div className="flex items-center">
          <img
            src={ZcashPNG}
            className="w-[25px] h-[25px] mr-3"
            alt="Zcash logo"
          />
          <span className="text-black text-base font-semibold font-inter whitespace-nowrap">
            Zcash WebZjs Wallet
          </span>
        </div>
      </Link>
      {isHomePage ?? (
        <nav className="flex">
          <a
            target="_blank"
            href="https://github.com/ZcashCommunityGrants/WebZjs"
            className="px-6 relative after:content-['|'] after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-[divide-dividerColor] hover:underline"
          >
            ZCash Docs
          </a>
          <a
            target="_blank"
            href="https://docs.metamask.io/snaps/"
            className="px-6 hover:underline"
          >
            Snap Docs
          </a>
          <a
            target="_blank"
            href="https://snaps.metamask.io/"
            className="hover:underline"
          >
            Snap Registry
          </a>
        </nav>
      )}
    </header>
  );
};

export default Header;
