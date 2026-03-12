[README.md](https://github.com/user-attachments/files/25921517/README.md)
# Jas and Dad CD's Inc

A Progressive Web App (PWA) for scanning CDs and records in op shops and quickly deciding whether they are profitable to flip on Discogs.

The app:

• scans CD / record barcodes  
• queries Discogs for release data  
• estimates resale value and profit  
• stores a local inventory  
• tracks op shops to revisit  
• exports inventory as CSV  

All data is stored locally on the device using **localStorage**.  
No backend or database is required.

---

## Features

### Discogs Scanner

Scan barcodes or manually search Discogs.

The app calculates:

- Discogs median price
- lowest listing
- demand (want vs for sale)
- suggested listing price
- estimated profit

### Inventory Manager

Tracks:

- title
- status (To clean / To list / Listed / Sold / Hold)
- quantity
- estimated profit
- list price
- condition notes

Inventory can be:

- filtered
- sorted
- exported to CSV

### Op Shop Tracker

Track op shops with:

- shop name
- suburb
- last visited date
- revisit interval
- notes

Shops are flagged as:

- Due
- Due soon
- OK

---

## Installation

Open the app in Chrome and choose **Install App**.

The PWA works offline once installed.

---

## Tech Stack

- Vanilla JavaScript
- Discogs API
- Progressive Web App
- Service Worker caching
- localStorage data storage

No frameworks or backend required.

---

## Project Structure

index.html  
styles.css  
app.js  
manifest.json  
sw.js  

---

## License

Personal project.
