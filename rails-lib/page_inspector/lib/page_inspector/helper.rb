# frozen_string_literal: true

module PageInspector
  # View helpers that surface the rendering controller#action and its source
  # file. Rendered as <meta> tags by app/views/page_inspector/_meta.html.erb so
  # the Shift-Click Issue Filer browser extension can report where a page came
  # from when you shift-click an element.
  module Helper
    # e.g. "DashboardController#show"
    def page_inspector_controller_label
      "#{controller.class.name}##{controller.action_name}"
    end

    # Best-effort path to the controller source, e.g.
    # "app/controllers/dashboard_controller.rb". Controllers that live in a gem
    # (Devise, etc.) won't resolve on disk — that's fine, it's a pointer.
    def page_inspector_controller_file
      "app/controllers/#{controller.controller_path}_controller.rb"
    end

    # The host application.s name, e.g. "MyApp" — lets a capture say
    # which app it came from even when the page was reached via a tunnel or
    # localhost URL that names no one.
    def page_inspector_app_name
      Rails.application.class.module_parent_name
    end
  end
end
