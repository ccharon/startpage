# Browser integration

The start page works with two URL parameters. `?add=` adds a bookmark and is used by the
bookmarklet. `?q=` searches and is used by the address bar search. The page reads the parameter after
the data has loaded and then removes it from the address, so a reload does not repeat the action.

## Adding the open page: `?add=<url>&title=<title>`

### Setup

1. Open the start page and click *Options*.
2. Click *Copy* next to *Bookmarklet*.
3. Create a new browser bookmark, for example in the bookmarks toolbar, and paste the copied text as
   its URL. Any name works, for example "+ Startpage".

The bookmarklet contains the address the start page had when you copied it. After changing host or
port, copy it again.

### Usage

Click the bookmarklet on any page. It opens
`http://localhost:8765/?add=<address of the page>&title=<title of the page>` in a new tab.

- The dialog "New bookmark" opens with URL and title filled in. Choose tags and category there.
- The bookmark is saved only after OK. Cancel discards it.
- If the URL is already saved, the dialog names the title and category of the existing bookmark. A
  second OK saves it anyway. A trailing slash is ignored in this comparison.
- Only `http` and `https` addresses are accepted. Other addresses are rejected with a notice.
- While the page is read-only because the server is not reachable, adding is rejected with a notice.

## Searching from the address bar: `?q=<terms>`

### Setup

The page offers the search engine "Bookmarks" to the browser through `/opensearch.xml`.

- Firefox: open the start page, then add "Bookmarks" from the search engine menu of the address bar.
  Under *Settings > Search*, give it a keyword, for example `bm`.
- Chrome: "Bookmarks" appears under *Settings > Search engine > Manage search engines and site
  search > Site search*. Activate it there and set a shortcut, for example `bm`.

### Usage

Type `bm jira` in the address bar. The browser opens `http://localhost:8765/?q=jira`, and the page
runs the same search as its search field.

| Result | Behavior |
|--------|----------|
| Strong match: every term occurs in the title, a tag or the host name of the best match | The tab goes directly to that bookmark and its visit is counted. |
| Only fuzzy matches, for example `jra` for "Jira" | The start page stays open with the results and the terms in the search field. |
| No match | The start page shows "No matches". Enter opens the input as an address or searches with the web search engine from *Options*. |

## Visits and ranking

Opening a bookmark increases its visit counter and stores the time of the visit. This applies to a
click, a middle click, Enter in the search and a direct jump through `?q=`. Among matches of similar
quality, often and recently used bookmarks rank higher, and they win the direct jump of `?q=`. Usage
never moves a fuzzy match above a text match.

## Known limitations

- Any website can link to these addresses. `?add=` saves nothing without OK, and `?q=` can only open
  one of your own bookmarks.
- Every visit changes the data file. In a synced folder this causes a sync per opened bookmark.
