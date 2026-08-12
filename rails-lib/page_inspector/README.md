# PageInspector

A tiny Rails engine that makes any page **shift-click friendly** for the
[Amplifier Chrome extension](../../README.md).

The extension already reads two things straight from the DOM on any site:

- the clicked **element** (tag / id / classes / text) and its **CSS DOM path**
- the **view / partial chain** — recovered from the HTML comments Rails emits
  when `annotate_rendered_view_with_filenames` is on:

  ```html
  <!-- BEGIN app/views/dashboard/show.html.erb -->
    <!-- BEGIN app/views/dashboard/_office_dashboard.html.erb --> … <!-- END … -->
  <!-- END app/views/dashboard/show.html.erb -->
  ```

PageInspector adds the last piece the DOM can't provide on its own: the
**controller#action** (and its source file), exposed as `<meta>` tags — and it
flips on the view annotations for you in development.

The result is exactly what the extension captures:

```
**Element:** `<a.block.overflow-hidden.rounded-xl> "Revenue $3.4k +517%"`
**DOM path:** `div#main-content-area > main.flex-1 > … > a.block:nth-of-type(1)`
**View / partials:**
- app/views/dashboard/show.html.erb
  - app/views/dashboard/_office_dashboard.html.erb
    - app/views/dashboard/widgets/_kpi_strip.html.erb
**Controller:** DashboardController#show (app/controllers/dashboard_controller.rb)
**URL:** https://your-app.example.com/
```

## Install (as a gem)

Point Bundler at this directory (or your fork/mirror of it):

```ruby
# Gemfile
group :development do
  gem "page_inspector", path: "vendor/page_inspector"
  # or vendor it straight out of https://github.com/schappim/amplifier-chrome
end
```

Then render the meta partial once, in your layout `<head>`:

```erb
<%# app/views/layouts/application.html.erb %>
<head>
  …
  <%= render "page_inspector/meta" %>
</head>
```

That's it. In development the engine sets
`config.action_view.annotate_rendered_view_with_filenames = true` and the partial
emits the controller tags. Shift-click any element and the extension composes the
full report.

## Install (copy-paste, no gem)

Don't want a gem? Copy three things into your app:

1. **The helper** → `app/helpers/page_inspector_helper.rb`:

   ```ruby
   module PageInspectorHelper
     def page_inspector_controller_label = "#{controller.class.name}##{controller.action_name}"
     def page_inspector_controller_file  = "app/controllers/#{controller.controller_path}_controller.rb"
     def page_inspector_app_name         = Rails.application.class.module_parent_name
   end
   ```

2. **An initializer** → `config/initializers/page_inspector.rb`:

   ```ruby
   if Rails.env.development?
     Rails.application.config.action_view.annotate_rendered_view_with_filenames = true
   end
   ```

3. **The meta tags** in your layout `<head>`:

   ```erb
   <% if Rails.application.config.action_view.annotate_rendered_view_with_filenames %>
     <meta name="dev-controller" content="<%= page_inspector_controller_label %>">
     <meta name="dev-controller-file" content="<%= page_inspector_controller_file %>">
     <meta name="dev-app-name" content="<%= page_inspector_app_name %>">
   <% end %>
   ```

## Where it runs

- **Development only** by default. View annotations put your view file paths into
  the HTML as comments, so they're gated behind `Rails.env.development?`.
- Need them on a protected staging box (e.g. an ngrok tunnel you're demoing)?
  Set `PAGE_INSPECTOR_ANNOTATE=1`. Force them off anywhere with
  `PAGE_INSPECTOR_ANNOTATE=0`.
- The `<meta>` tags are only rendered when annotations are on, so production stays
  clean.

## Compatibility

The extension reads the meta names `dev-controller` and `dev-controller-file` —
the same names a Rails app.s own dev inspector usually uses — so an app that already has
that inspector needs nothing extra. `dev-app-name` (added in 1.1.0) is optional:
when present, captures and review-bar comments say **which app** the page belongs
to, which matters when it was reached via a tunnel or localhost URL.
