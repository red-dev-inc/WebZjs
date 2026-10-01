import React from 'react';
import { ZcashPNG } from '../../assets';

const Footer = (): React.JSX.Element => {
  return (
    <footer className="w-full py-6 flex items-center justify-center font-medium">
      <div className="flex items-center text-xs">
        <span className="block mr-1 text-xs">Made and Maintained by</span>
        <a
          className="inline-flex items-center justify-center"
          href="https://zcashcommunitygrants.org/"
          target="_blank"
        >
          <div className="inline-block w-6 h-6 mr-1">
            <img
              src={ZcashPNG}
              className="w-5 h-[20px]"
              alt="Zcash Community Grants logo"
            />
          </div>
          Zcash Community Grants
        </a>
      </div>
    </footer>
  );
};

export default Footer;
