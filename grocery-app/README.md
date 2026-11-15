# Shop Books: accounting and stock for the Sharjah grocery

A small offline app for running the books and stock of a ~300 sq ft grocery (baqala). It is **one file**, `shop-books.html`. You do not need a server, an internet connection or an install. Amounts are in AED and VAT is 5%.

## Start

1. Copy `shop-books.html` to the shop computer, for example to the Desktop.
2. Double-click it. It opens in Chrome or Edge. Bookmark it.
3. Always open it **in the same browser on the same computer**, because that browser holds your data.
4. Before entering real figures, you can try the app: go to **Settings & backup**, click **Load demo data**, look around, then click **Erase all data**.

## First-time setup

1. **Settings & backup**: enter the shop name, your VAT TRN, and the cash in hand and bank balance on the day you start.
2. **Suppliers**: add each supplier with its credit days, for example the dairy van at 14 days, the drinks distributor at 30 days and cash-and-carry at 0.
3. **Items**: add each product with its barcode (click the box and scan), category, cost excl. VAT, shelf price incl. VAT, reorder level and how many you have now. The margin shows as you type.

## Barcode scanning

- **USB or Bluetooth scanner (recommended, about AED 60 to 150):** plug it in and scan. It works on **Sell**, **Buy stock**, **Items** and **Stock count**, even when you have not clicked in a box first.
- **New barcode?** When you scan a barcode the app does not know on Sell or Buy stock, a small **New item** form opens with the barcode already filled in. Enter the name, cost and price and save, and the item goes straight into the sale or invoice.
- **Items page:** scan at the top. A known item opens for editing, and a new barcode starts a new item.
- **Camera:** a **📷 Camera** button appears where the browser has a built-in barcode reader (Chrome on Android phones and tablets, Mac and ChromeOS). Chrome on Windows usually does not have one, so use a USB scanner there.

## Daily use

The menu groups related pages: **Sales** (Sell, Customers), **Purchases** (Suppliers, Buy stock, Pay suppliers, Expenses), **Stock** (Items, Stock count) and **Money** (Cash & bank, Reports).

| Page | What to do |
|---|---|
| **Sell** | Scan items, or type the name and press Enter. Choose cash, card or delivery app, then click **Save sale**. Stock goes down. Use "Item not in the list" for loose vegetables and similar. |
| **Customers** | Customers who buy on credit and pay at month end. On **Sell**, choose **Credit (customer pays later)** and pick the customer, or click **+ New customer** (name, flat no. and building are separate fields). Each customer gets a code (C001, C002 and so on). You can change it, and typing the code picks the customer on Sell and Customers. You can set a credit limit, and the app warns you when a sale would take the customer over it. The Customers page shows who owes what and has a printable **Statement** for each customer. Record payments there when they pay. |
| **Buy stock** | Enter each supplier invoice: scan the items, enter qty and cost, and check that the VAT matches the invoice. Choose **On credit** if you will pay later. Click **+ New supplier** to add a supplier without leaving the page. Stock goes up and the item cost updates. |
| **Pay suppliers** | Shows what you owe, which bills are overdue and which are due soon. Record each payment here. |
| **Expenses** | Record rent cheques, salaries, SEWA, card fees, app commissions, fuel and so on. VAT fills in for bills that usually carry it. Correct it to match the bill. |
| **Cash & bank** | Record bank deposits, withdrawals, money the owner puts in or takes out, and VAT payments. Use **Cash-up check** at closing to compare the drawer with the book. |
| **Margin** | The investor's share is 18% of each day's sales excl. VAT. It shows in the top bar next to Cash and Bank, and on Home as today's figure, this month's figure and the amount still to pay. Record payments on **Cash & bank → Pay margin**. You can change the % in **Settings & backup**. **Reports** shows it by day and deducts it after net profit. |
| **Home (dashboard)** | Today's sales against the plan's AED 3,500 daily break-even, gross profit and the 18% margin. It also shows this month's sales, profit, expenses and VAT, plus cash, bank, money owed both ways, stock value and low stock. Charts show daily sales for the last 30 days, sales against costs by month, how customers paid, top items and sales by category. Hover over any bar to see its numbers. Alerts cover low stock, overdue bills, customers over their limit, the quarterly stock count and backups. |

Card and delivery-app sales go straight to the **bank** balance. Cash sales go to **cash** until you record a deposit.

## Reports

**Reports** has a period picker (month, quarter, year, custom dates) and shows:

- **Profit and loss**: sales excl. VAT, cost of goods sold, stock-count losses, expenses by type, net profit before owner pay, and sales and margin by category.
- **Cash flow**: opening cash and bank, money in and out by type, and closing balances.
- **VAT summary**: output VAT on sales, input VAT on purchases and expenses, and the net VAT to pay or reclaim. Pick the quarter that matches your FTA tax period and give it to your accountant.

**Print reports** prints them. **Export all entries (CSV)** downloads every entry for Excel or the accountant.

## Quarterly stock count

1. Go to **Stock count** after closing, choose **All items** (or one category, for example a weekly cigarette count), and click **Start count**.
2. Click **Print count sheet**. Staff write the shelf quantities on it. Leave "show expected qty" unticked so they count without knowing the expected figure.
3. Type the counted quantities into the app. You can scan a barcode to jump to that item, and Enter moves to the next row. Rows left blank are not adjusted.
4. Check the variance (quantity and AED at cost) and click **Print variance report** if you want a copy.
5. Click **Apply adjustments and close count**. Stock now matches the shelves, and the loss shows in the P&L as "Stock count variance". The plan's target is under 1% of sales.

## Backups

Your data is saved **only in this browser**. Clearing the browser history and site data, or using a private window, can lose it.

- Go to **Settings & backup → Download backup file** at least weekly (daily is better). Keep copies on a USB stick or in email or cloud storage. The home page warns you when the last backup is more than 7 days old.
- To move to a new computer, open the app there and click **Restore from backup**.

## Good to know

- To fix a mistake, delete the entry and enter it again. Stock and balances recalculate automatically.
- Expenses count in the month they are paid, so a AED 15,000 quarterly rent cheque makes that month look bad. Use the quarter view for a fair picture.
- An item's cost is the last price you paid for it. Each sale records the cost at the time of the sale.
- This app keeps simple management books. Your accountant still files the VAT and Corporate Tax returns, and should check how you record items such as the rent deposit and fit-out costs.
