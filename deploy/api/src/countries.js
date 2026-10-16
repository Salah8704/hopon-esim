'use strict';

const namesFr=new Intl.DisplayNames(['fr'],{type:'region'});
const namesEn=new Intl.DisplayNames(['en'],{type:'region'});

const clean=value=>String(value??'').trim();
const normalizedIso=value=>{
  const iso=clean(value).toUpperCase();
  return /^[A-Z]{2}$/.test(iso)?iso:null;
};

function nameFr(iso2,fallback=''){
  const iso=normalizedIso(iso2);
  return (iso&&namesFr.of(iso))||clean(fallback)||iso||'International';
}

function nameEn(iso2,fallback=''){
  const iso=normalizedIso(iso2);
  return (iso&&namesEn.of(iso))||clean(fallback)||iso||'International';
}

function flag(iso2,fallback=''){
  const iso=normalizedIso(iso2);
  if(!iso)return clean(fallback)||'🌍';
  return String.fromCodePoint(...iso.split('').map(character=>127397+character.charCodeAt(0)));
}

module.exports={nameFr,nameEn,flag,normalizedIso};
