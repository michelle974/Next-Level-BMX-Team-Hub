// /api/_nationals.js  (underscore = helper module, not a route)
//
// Race weekend details for USA BMX national events, transcribed from each
// event's official race flyer (linked as `flyer`). Same shape the Sunshine
// State parser returns, so the Team Hub renders one Race Weekend card for both.
//
// To add a national: copy a block, set start/end (YYYY-MM-DD), the USA BMX
// event id (from usabmx.com/events/{id}) and the flyer asset id, then fill days.
// Any national NOT listed here still gets a basic card (venue, Pre-Sign, flyer)
// pulled live from USA BMX by raceinfo.js.

const EV = id => `https://www.usabmx.com/events/${id}`;
const FLY = id => `https://admin.usabmx.com/assets/${id}`;

const TRANSPONDERS = 'Transponders required for Cruiser, Girl/Women Cruiser, Expert, Girl/Women Expert and Expert Open. No exceptions.';
const FIRST_NATIONAL = 'First-ever national? Pre-sign online and get a FREE second entry at the event.';
const PREREG = 'Register online 8 days before for the pre-registration discount.';

// Standard Friday practice by class (same at Gator and Texas).
const FRI_PRACTICE = [
  ['8:30am - 8:50am', '12 & Under Cruiser Boys & Girls'],
  ['8:50am - 9:10am', '13-30 Cruiser Boys & Girls'],
  ['9:10am - 9:30am', '31 & Over Cruiser Men & Women'],
  ['9:30am - 9:50am', '6 & Under Boys & Girls 20"'],
  ['9:50am - 10:10am', '7-12 Girls 20"'],
  ['10:10am - 10:30am', '13 & Over Girls 20"'],
  ['10:30am - 10:50am', '7-8 Boys 20"'],
  ['10:50am - 11:10am', '9-10 Boys 20"'],
  ['11:10am - 11:30am', '11-12 Boys 20"'],
  ['11:30am - 11:50am', '13-14 Boys 20"'],
  ['11:50am - 12:10pm', '15-20 Men 20"'],
  ['12:10pm - 12:30pm', '21-40 Men 20"'],
  ['12:30pm - 12:50pm', '41 & Over Men 20"'],
];
const rows = list => list.map(([time, text]) => ({ time, text }));

export const NATIONALS = [
  /* ---------------- Gator Nationals ---------------- */
  {
    start: '2026-10-21', end: '2026-10-25', // Wed clinic, Thu practice + Fri-Sun racing
    post: {
      title: 'Gator Nationals',
      series: 'USA BMX National · Races 1-3',
      venue: 'Oldsmar BMX Supercross · Oldsmar, FL',
      url: EV(634637),
      preSign: EV(634637),
      hotels: 'https://www.bmxhotels.com',
      flyer: FLY('b23524b6-cb91-4604-8478-c82efc170817'),
      address: ['Oldsmar Sports Complex', '3120 Tampa Road, Oldsmar, FL 34677'],
      info: [
        { label: 'Parking', value: '$10 per day or $25 for the weekend · VIP $100 for the weekend' },
        { label: 'Camping', value: '$225 (Thursday-Saturday) · no daily passes' },
        { label: 'Hotels', value: 'BMXHotels.com rates as low as $152 per night' },
      ],
      notes: [TRANSPONDERS, FIRST_NATIONAL, PREREG, 'Vendors: Full Tilt, J & R Bicycles, Hellfire BMX, Aker Brand & Glitter Lens'],
      days: [
        {
          heading: 'Wednesday, October 21', note: 'Beginner Clinic',
          blocks: [{ title: '', items: rows([['5:00pm - 7:00pm', 'Beginner Clinic']]) }],
        },
        {
          heading: 'Thursday, October 22', note: 'Elite Hill, Pro Clinic and practice by age',
          blocks: [
            { title: '', items: rows([
              ['10:00am - 1:00pm', 'Elite Hill practice'],
              ['1:30pm - 3:30pm', 'Pro Clinic'],
              ['5:00pm - 8:00pm', 'Practice by age group'],
            ]) },
            { title: 'Practice by Age', items: rows([
            ['5:00pm - 5:45pm', '12 & Under'],
            ['5:45pm - 6:30pm', '13 & Over'],
            ['6:30pm - 7:15pm', '12 & Under'],
            ['7:15pm - 8:00pm', '13 & Over'],
          ]) }],
        },
        {
          heading: 'Friday, October 23', note: 'Race 1',
          blocks: [
            { title: '', items: [
              ...rows([
                ['8:30am - 1:00pm', 'Sign-ups'],
                ['12:30pm', 'Online registration for Friday closes'],
                ['2:15pm', 'Balance Bike'],
                ['2:30pm', 'Race begins'],
              ]),
              { text: 'Onsite registration for Saturday closes at the end of Friday mains. No exceptions.' },
            ] },
            { title: 'Practice Schedule', items: rows([
              ...FRI_PRACTICE,
              ['12:50pm - 1:15pm', 'Vet Pro / ABA Futures'],
              ['1:15pm - 1:40pm', 'Women Pro (Junior Women)'],
              ['1:40pm - 2:05pm', 'Men Pro (Junior Men)'],
            ]) },
          ],
        },
        {
          heading: 'Saturday, October 24', note: 'Race 2 · no practice',
          blocks: [
            { title: '', items: rows([
              ['7:00am', 'Online sign-ups close'],
              ['7:30am - 8:30am', 'Moto corrections'],
              ['9:15am', 'Balance Bike'],
              ['9:30am', 'Race starts'],
            ]) },
            { title: 'Warm-up', items: rows([
              ['7:15am - 7:45am', '12 & Under Male & Female'],
              ['7:45am - 8:15am', '13-20 Male & Female'],
              ['8:15am - 8:45am', '21 & Over Male & Female'],
              ['8:45am - 9:15am', 'Pro Warm-up'],
              ['9:15am - 9:30am', 'Balance Bike'],
            ]) },
          ],
        },
        {
          heading: 'Sunday, October 25', note: 'Race 3 · no sign-ups, no practice',
          blocks: [{ title: '', items: rows([['8:00am', 'Race begins']]) }],
        },
      ],
    },
  },

  /* ---------------- Texas Nationals ---------------- */
  {
    start: '2026-10-30', end: '2026-11-01',
    post: {
      title: 'Texas Nationals',
      series: 'USA BMX National · Races 1-3',
      venue: 'Capitol City BMX · Pflugerville, TX',
      url: EV(634638),
      preSign: EV(634638),
      hotels: 'https://www.bmxhotels.com',
      flyer: FLY('c08b4159-87cc-49d6-800c-316ee1b6aa15'),
      address: ['5001 Killingsworth Lane, Pflugerville, TX 78660'],
      info: [
        { label: 'Parking', value: 'Cars $10 per day / $30 per weekend · VIP lot (cars only, no trailers) $25 per day / $75 per weekend' },
        { label: 'Camping', value: 'RV $50 per day / $150 per weekend · arrive Thursday, leave Sunday · pre-sale through Oct 23 at capitolcitybmx.square.site' },
        { label: 'Hotels', value: 'BMXHotels.com rates as low as $106 per night' },
      ],
      notes: [TRANSPONDERS, FIRST_NATIONAL, PREREG, 'Vendors: Full Tilt, On 2 Wheels BMX, Flex Racing, Rad and Fast, NoLogo, 8 Degree Pedal'],
      days: [
        {
          heading: 'Friday, October 30', note: 'Race 1',
          blocks: [
            { title: '', items: [
              ...rows([
                ['8:00am - 11:30am', 'Sign-ups'],
                ['11:00am', 'Online registration for Friday closes'],
                ['1:00pm', 'Balance Bike'],
                ['1:00pm', 'Race begins'],
              ]),
              { text: 'Onsite registration for Saturday closes at the end of Friday mains. No exceptions.' },
            ] },
            { title: 'Practice Schedule', items: rows(FRI_PRACTICE) },
          ],
        },
        {
          heading: 'Saturday, October 31', note: 'Race 2 · no practice',
          blocks: [
            { title: '', items: [
              ...rows([
                ['7:00am', 'Online registration for Saturday closes'],
                ['9:30am', 'Race starts'],
              ]),
              { text: 'Online and onsite registration for Sunday close at the end of Saturday mains. No exceptions.' },
            ] },
            { title: 'Warm-up', items: rows([
              ['7:45am - 8:15am', '12 & Under Male & Female'],
              ['8:15am - 8:45am', '13-20 Male & Female'],
              ['8:45am - 9:15am', '21 & Over Male & Female'],
              ['9:15am - 9:30am', 'Balance Bike'],
            ]) },
          ],
        },
        {
          heading: 'Sunday, November 1', note: 'Race 3 · no sign-ups, no practice',
          blocks: [{ title: '', items: rows([['8:00am', 'Race begins']]) }],
        },
      ],
    },
  },

  /* ---------------- Grand Nationals ---------------- */
  {
    start: '2026-11-25', end: '2026-11-29',
    post: {
      title: 'Race of Champions / Grand Nationals',
      series: 'USA BMX Grands',
      venue: 'SageNet Center · Tulsa, OK',
      url: EV(651988),
      preSign: EV(651988),
      hotels: '',
      flyer: FLY('a68592cb-788a-48d9-bfd4-5c8263a90f5e'),
      address: ['SageNet Center, Tulsa, OK'],
      info: [
        { label: 'Admission', value: 'Friday night Pro Championship Finals $20 at the door' },
        { label: 'Hotels', value: 'Official host hotel: Hyatt Regency Tulsa (bikes allowed in rooms)' },
      ],
      notes: [
        'ROC plates are given for Open, Cruiser and Class. Riders race the age and skill level they were as of August 31.',
        'Moto-by-moto "not before" start times for each class are on the flyer.',
        'Hall of Fame and Museum open 9:00am-5:00pm daily (closed Sunday).',
      ],
      days: [
        {
          heading: 'Wednesday, November 25', note: 'Only day of practice · only day to register for ROC',
          blocks: [
            { title: '', items: [
              ...rows([
                ['6:15am', 'Gates open'],
                ['7:00am', 'Practice starts'],
                ['7:00am - 3:00pm', 'Registration'],
                ['3:00pm', 'Race of Champions team sheets due'],
                ['4:00pm', 'ROC motos posted online'],
                ['4:00pm - 6:00pm', 'ROC corrections (none after 6:00pm)'],
              ]),
              { text: 'Bikes are inspected in staging behind the starting hill, so allow time.' },
            ] },
            { title: 'Practice Schedule', items: rows([
              ['7:00am - 7:30am', '16 & Under Girls Cruiser'],
              ['7:30am - 8:00am', '17 & Over Womens Cruiser'],
              ['8:00am - 8:30am', '9 & Under Boys Cruiser'],
              ['8:30am - 9:00am', '10-12 Boys Cruiser'],
              ['9:00am - 9:30am', '13-16 Boys Cruiser'],
              ['9:30am - 10:00am', '17-45 Mens Cruiser'],
              ['10:00am - 10:30am', '46 & Over Mens Cruiser'],
              ['10:30am - 11:20am', 'Pros'],
              ['11:20am - 11:50am', '16 Boys 20"'],
              ['11:50am - 12:30pm', '17-20 Mens 20"'],
              ['12:30pm - 1:00pm', '10 & Under Girls 20"'],
              ['1:00pm - 1:30pm', '11-14 Girls 20"'],
              ['1:30pm - 2:10pm', '15 & Over Girls 20"'],
              ['2:10pm - 2:35pm', '5 & Under Boys 20"'],
              ['2:35pm - 3:00pm', '6 Boys 20"'],
              ['3:00pm - 3:25pm', '7 Boys 20"'],
              ['3:25pm - 3:55pm', '8 Boys 20"'],
              ['3:55pm - 4:25pm', '9 Boys 20"'],
              ['4:25pm - 4:55pm', '10 Boys 20"'],
              ['4:55pm - 5:25pm', '11 Boys 20"'],
              ['5:25pm - 5:55pm', '12 Boys 20"'],
              ['5:55pm - 6:25pm', '13 Boys 20"'],
              ['6:25pm - 6:55pm', '14 Boys 20"'],
              ['6:55pm - 7:25pm', '15 Boys 20"'],
              ['7:25pm - 7:50pm', '21-25 Mens 20"'],
              ['7:50pm - 8:15pm', '26-35 Mens 20"'],
              ['8:15pm - 8:40pm', '36-40 Mens 20"'],
              ['8:40pm - 9:05pm', '41-45 Mens 20"'],
              ['9:05pm - 9:30pm', '46-50 Mens 20"'],
              ['9:30pm - 9:55pm', '51-55 Mens 20"'],
              ['9:55pm - 10:20pm', '56 & Over Mens 20"'],
            ]) },
          ],
        },
        {
          heading: 'Thursday, November 26', note: 'Race of Champions day 1 (invite only)',
          blocks: [{ title: '', items: [
            ...rows([
              ['7:00am', 'Gates open'],
              ['7:50am', 'Parade lap (all 2025 ROC #1s)'],
              ['8:00am', 'Pros first round'],
              ['8:30am', 'Balance Bikes warm-up & racing'],
            ]),
            { text: 'Registration trailer closed today. Online registration for the Grands stays open.' },
          ] }],
        },
        {
          heading: 'Friday, November 27', note: 'Race of Champions day 2 · Pro Championship Finals at night',
          blocks: [
            { title: '', items: [
              ...rows([
                ['7:00am', 'Gates open'],
                ['7:00am - 3:00pm', 'Last chance on-site Grands registration'],
                ['8:00am', 'Racing starts (Pros start the day)'],
                ['2:30pm', 'Online Grands registration closes'],
                ['3:00pm', 'NAG 5 riders sign up at the USA BMX trailer by now'],
              ]),
              { text: 'Grands team sheets must be turned in by the end of the Friday race.' },
            ] },
            { title: 'Friday Night Pro Championship Finals / NAG 5 Challenge', items: rows([
              ['6:00pm', 'Gates open'],
              ['6:30pm', 'Warm-up'],
              ['7:00pm', 'Event starts ($20 at the door)'],
            ]) },
          ],
        },
        {
          heading: 'Saturday, November 28', note: 'Grands day 1',
          blocks: [{ title: '', items: rows([
            ['7:00am', 'Gates open · motos posted online'],
            ['7:00am - 7:30am', 'Grands corrections (online only)'],
            ['7:50am', 'Parade lap (2025 overall National #1 teams & riders)'],
            ['8:00am', 'Balance Bikes warm-up & racing'],
            ['8:30am', 'Amateur racing starts'],
          ]) }],
        },
        {
          heading: 'Sunday, November 29', note: 'Grands day 2',
          blocks: [{ title: '', items: [
            ...rows([
              ['7:00am', 'Gates open'],
              ['8:00am', 'Racing starts'],
            ]),
            { text: 'Mains take about 3.5 to 4 hours. Each title is given out at the end of its class division.' },
            { text: 'National & NAG awards: upper level, at the blue USA BMX semi trailer during mains.' },
          ] }],
        },
      ],
    },
  },
];
